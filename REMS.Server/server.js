const net = require('net');      // 소켓 통신 모듈
const mysql = require('mysql2'); // MySQL DB 모듈
const express = require('express'); // 웹 서버 모듈
const cors = require('cors');       // CORS 모듈

// ==========================================
// [1] 환경 설정 (Configuration)
// ==========================================
const CONFIG = {
    TCP_PORT: 5000,   // 기존 소켓 포트
    HTTP_PORT: 3000,  // API 서버 포트
    HOST: '0.0.0.0',
    DB: {
        host: 'localhost',
        user: 'root',
        password: '1234',
        database: 'rems_db'
    },
};

const connectedSockets = [];

let GLOBAL_STATE = {
    targetPwm: 0, 
    isMotorRunning: false,
    isAutoSequenceRunning: false
};

// 인터럽트 컨트롤러 저장용 변수
let autoSequenceController = null;

// ==========================================
// [2] 데이터베이스 연결
// ==========================================
const dbConnection = mysql.createConnection(CONFIG.DB);

dbConnection.connect((err) => {
    if (err) {
        console.error('❌ [DB] 연결 실패:', err.message);
        return;
    }
    console.log('✅ [DB] MySQL 데이터베이스 연결 성공!');
});

// ==========================================
// [3] 헬퍼 함수 (Utility Functions)
// ==========================================
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function sendToTarget(message, targetType) {
    console.log(`[Server->${targetType}] 명령 전송: [${message}]`);
    connectedSockets.forEach((sock) => {
        if (sock.writable && sock.clientType === targetType) {
            sock.write(message + "\n");
        }
    });
}

const wait = (ms, signal) => {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            return reject(new Error("⚠️ 긴급 정지 (즉시 중단)"));
        }
        const timer = setTimeout(() => {
            resolve();
        }, ms);
        if (signal) {
            signal.addEventListener('abort', () => {
                clearTimeout(timer);
                reject(new Error("⚠️ 긴급 정지 (인터럽트 발생)"));
            }, { once: true });
        }
    });
};

// ==========================================
// [4] TCP 서버 메인 로직 (Port 5000)
// ==========================================
const tcpServer = net.createServer((socket) => {
    console.log(`\n✅ [TCP Client] 새로운 접속: ${socket.remoteAddress}`);
    socket.clientType = 'WPF'; 
    connectedSockets.push(socket);

    // [기능 A] 자동 공정 시퀀스
    async function runAutoSequence() {
        if (GLOBAL_STATE.isAutoSequenceRunning) return; 
        GLOBAL_STATE.isAutoSequenceRunning = true;

        autoSequenceController = new AbortController();
        const { signal } = autoSequenceController; 

        const sendLog = (msg) => sendToTarget(`LOG:${msg}`, 'WPF');
        const sendPwmToFw = (pwmValue) => {
            GLOBAL_STATE.targetPwm = pwmValue;
            sendToTarget(`PWM:${pwmValue}`, 'FW');
        };

        try {
            GLOBAL_STATE.isMotorRunning = true;
            sendPwmToFw(0);
            sendLog(`[AUTO] STEP1: 안전 점검 시작 (3초)`);
            await wait(3000, signal); 

            for (let i = 3; i > 0; i--) {
                sendLog(`[AUTO] 장비 점검 중... ${i}초 남음`);
                await wait(1000, signal);
            }

            sendPwmToFw(30);
            sendLog(`[AUTO] STEP2: 모터 가속 시작 PWM 30%`);
            for (let i = 1; i <= 5; i++) {
                sendLog(`[AUTO] 가속 유지 중... (${i}/5초)`);
                await wait(1000, signal);
            }

            sendPwmToFw(85);
            sendLog(`[AUTO] STEP3: 메인 공정 진입 PWM 85%`);
            for (let i = 1; i <= 10; i++) {
                if (i === 1 || i % 5 === 0) sendLog(`[AUTO] 고속 운전 중... (${i}/10초)`);
                await wait(1000, signal);
            }

            sendPwmToFw(15);
            sendLog(`[AUTO] STEP4: 공정 종료 및 감속 PWM 15%`);
            await wait(3000, signal);

            sendPwmToFw(0);
            GLOBAL_STATE.isMotorRunning = false;
            sendLog("[DONE] ✅ 모든 자동 공정 시퀀스 완료.");

        } catch (err) {
            console.log(`🛑 시퀀스 강제 중단: ${err.message}`);
            sendLog(`[STOP] 🛑 비상 정지 발동! 공정을 즉시 중단.`);
            sendPwmToFw(0); 
        } finally {
            GLOBAL_STATE.isAutoSequenceRunning = false;
            autoSequenceController = null;
        }
    }

    // [기능 C] 데이터 수신
    socket.on('data', (data) => {
        const msg = data.toString().trim();
        if (msg === "") return;

        // 1. 펌웨어(FW)가 보낸 데이터 처리
        if (msg.startsWith('RSSI:')) {
            socket.clientType = 'FW'; 
            let rssi = 0, rpm = 0;
            try {
                const parts = msg.split(',');
                parts.forEach(part => {
                    const [key, val] = part.split(':');
                    if (key === 'RSSI') rssi = parseInt(val);
                    if (key === 'RPM') rpm = parseInt(val);
                });
            } catch (e) { console.error('파싱 에러:', e); }

            if (GLOBAL_STATE.targetPwm === 0 && rpm > 100) {
                 sendToTarget("PWM:0", "FW");
            }

            // DB 저장 (sensor_logs 테이블)
            // 주의: DB 테이블 컬럼명이 rssi, rpm 이어야 함
            const sql = `INSERT INTO sensor_logs (rssi, rpm, created_at) VALUES (?, ?, NOW())`;
            dbConnection.query(sql, [rssi, rpm], (err) => {
                if (err) console.error("DB Insert Error:", err.message);
            });

            const combinedData = `RSSI:${rssi},RPM:${rpm},PWM:${GLOBAL_STATE.targetPwm}`;                
            sendToTarget(combinedData, 'WPF'); 
            return; 
        }

        // 2. WPF가 보낸 명령 처리
        console.log(`\n[${socket.clientType}->Server] 명령 수신: [${msg}]`);

        if (msg.startsWith('PWM:')) {
            const value = parseInt(msg.split(':')[1]);
            if (!isNaN(value)) {
                GLOBAL_STATE.targetPwm = value; 
                sendToTarget(msg, 'FW'); 
            }
            return;
        }

        switch (msg) {
            case 'AUTO_START': runAutoSequence(); break;
            case 'LED_ON': sendToTarget("LED_ON", 'FW'); break;
            case 'LED_OFF': sendToTarget("LED_OFF", 'FW'); break;
            case 'MOTOR_RUN': 
                GLOBAL_STATE.isMotorRunning = true; 
                sendToTarget("MOTOR_RUN", 'FW'); 
                break;
            case 'EMERGENCY_STOP': 
                console.log("[ALERT] 비상 정지 요청 수신!");
                if (autoSequenceController) autoSequenceController.abort();
                GLOBAL_STATE.isMotorRunning = false;
                GLOBAL_STATE.targetPwm = 0; 
                sendToTarget("EMERGENCY_STOP", 'FW'); 
                sendToTarget("PWM:0", 'FW'); 
                sendToTarget("LED_OFF", 'FW'); 
                break;
            default: console.log(`⚠️ [System] 알 수 없는 명령: ${msg}`);
        }
    });

    // 접속 종료 처리
    const handleDisconnect = () => {
        console.log(`❌ [TCP Client] 접속 해제: ${socket.clientType}`);
        const index = connectedSockets.indexOf(socket);
        if (index > -1) connectedSockets.splice(index, 1);
    };

    socket.on('end', handleDisconnect);
    socket.on('error', (err) => handleDisconnect());
});

// ==========================================
// [5] HTTP API 서버 추가 (Port 3000)
// ==========================================
const app = express();
app.use(cors()); // CORS 허용
app.use(express.json());

// DB 검색 API
// 요청: GET http://localhost:3000/api/logs?start=2026-01-26&end=2026-01-27
app.get('/api/logs', (req, res) => {
    const startDate = req.query.start;
    const endDate = req.query.end;

    console.log(`🔎 [API] 검색 요청: ${startDate} ~ ${endDate}`);

    // DB 테이블 이름이 'sensor_logs'라고 가정 (위의 Insert 구문 참고)
    // C# LogDataModel과 이름 매칭을 위해 AS 사용
    const sql = `
        SELECT 
            id AS Id, 
            DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS Timestamp, 
            '192.168.0.10' AS IpAddress, 
            rssi AS Rssi, 
            rpm AS Rpm, 
            IF(rpm > 0, 'Running', 'Stopped') AS Status
        FROM sensor_logs 
        WHERE DATE(created_at) >= ? AND DATE(created_at) <= ?
        ORDER BY id DESC
    `;

    dbConnection.query(sql, [startDate, endDate], (err, results) => {
        if (err) {
            console.error('❌ [API] DB 에러:', err);
            res.status(500).send('DB Error');
        } else {
            console.log(`✅ [API] ${results.length}건 데이터 반환 완료`);
            res.json(results);
        }
    });
});

// ==========================================
// [6] 서버 실행 (두 포트 모두 실행)
// ==========================================
// 1. TCP 서버 실행 (5000)
tcpServer.listen(CONFIG.TCP_PORT, CONFIG.HOST, () => {
    console.log(`🚀 TCP Server running on port ${CONFIG.TCP_PORT}`);
});

// 2. HTTP 서버 실행 (3000)
app.listen(CONFIG.HTTP_PORT, () => {
    console.log(`🌍 HTTP API Server running on port ${CONFIG.HTTP_PORT}`);
});