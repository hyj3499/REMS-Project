const net = require('net');      // 소켓 통신 모듈
const mysql = require('mysql2'); // MySQL DB 모듈

// ==========================================
// [1] 환경 설정 (Configuration)
// ==========================================
const CONFIG = {
    PORT: 5000,
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
    targetPwm: 0, // PWM 초기값
    isMotorRunning: false,
    isAutoSequenceRunning: false
};

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

// 타겟 지정 전송 함수 (일방향 통신)
// targetType: 'FW' (Firmware) 또는 'WPF' (Client) 
function sendToTarget(message, targetType) {
    console.log(`[Server->${targetType}] 명령 전송: [${message}]`);

    connectedSockets.forEach((sock) => {
        // 소켓이 연결되어 있고 && 내가 찾는 타입일 때만 전송
        if (sock.writable && sock.clientType === targetType) {
            sock.write(message + "\n");
        }
    });
}
// ==========================================
// [4] 서버 메인 로직
// ==========================================
const server = net.createServer((socket) => {
    console.log(`\n✅ [Client] 새로운 접속: ${socket.remoteAddress}`);
    // 기본 타입은 'WPF' (나중에 WPF나 FW로 구체화됨)
    socket.clientType = 'WPF'; 
    connectedSockets.push(socket);

    // ----------------------------------------------------
    // [기능 A] 자동 공정 시퀀스 (Auto Sequence)
    // ----------------------------------------------------

async function runAutoSequence() {
        if (GLOBAL_STATE.isAutoSequenceRunning) return; 
        GLOBAL_STATE.isAutoSequenceRunning = true;

        const sendLog = (msg) => sendToTarget(`LOG:${msg}`, 'WPF');
        
        const sendPwmToFw = (pwmValue) => {
            GLOBAL_STATE.targetPwm = pwmValue; // 1. 서버 기억
            sendToTarget(`PWM:${pwmValue}`, 'FW'); // 2. 아두이노 전송
        };

        try {
            GLOBAL_STATE.isMotorRunning = true;

            // STEP 1: 안전 점검
            sendPwmToFw(0); // ★ 함수 호출로 변경
            sendLog(`[AUTO] STEP1: 안전 점검 시작 (3초)`);
            for (let i = 3; i > 0; i--) {
                sendLog(`[AUTO] 장비 점검 중... ${i}초 남음`);
                await delay(1000);
            }

            // STEP 2: 가속
            sendPwmToFw(30); // ★ 함수 호출로 변경 (이게 빠져 있었음!)
            sendLog(`[AUTO] STEP2: 모터 가속 시작 PWM 30%`);
            for (let i = 1; i <= 5; i++) {
                sendLog(`[AUTO] 가속 유지 중... (${i}/5초)`);
                await delay(1000);
            }

            // STEP 3: 고속 공정
            sendPwmToFw(85); // ★ 함수 호출로 변경
            sendLog(`[AUTO] STEP3: 메인 공정 진입 PWM 85%`);
            for (let i = 1; i <= 10; i++) {
                if (i === 1 || i % 5 === 0) sendLog(`[AUTO] 고속 운전 중... (${i}/10초)`);
                await delay(1000);
            }

            // STEP 4: 종료
            sendPwmToFw(15); // ★ 함수 호출로 변경
            sendLog(`[AUTO] STEP4: 공정 종료 및 감속 PWM 15%`);
            await delay(3000);

            // 완료
            sendPwmToFw(0); // ★ 함수 호출로 변경
            GLOBAL_STATE.isMotorRunning = false;
            sendLog("[DONE] ✅ 모든 자동 공정 시퀀스 완료.");

        } catch (err) {
            sendLog("[ERR] ❌ 오류 발생");
            console.error(err);
        } finally {
            GLOBAL_STATE.isAutoSequenceRunning = false;
        }
    }
    // ----------------------------------------------------
    // [기능 B] 기존 setInterval(시뮬레이션 루프)은 삭제
    // ----------------------------------------------------

    // ----------------------------------------------------
    // [기능 C] 데이터 수신 (Firmware -> Server) 및 라우팅
    // ----------------------------------------------------
    socket.on('data', (data) => {
            const msg = data.toString().trim();
            if (msg === "") return; //메시지가 비어있으면 그냥 무시하고 함수 종료
            
        // ============================================
        // 1. 펌웨어(FW)가 보낸 데이터 처리
        // 포맷: "RSSI:-60,RPM:1200,PWM:50"
        // ============================================
            if (msg.startsWith('RSSI:')) {
                socket.clientType = 'FW'; 

                // 1-1. 파싱 (RSSI, RPM 추출)
                let rssi = 0, rpm = 0;
                try {
                    const parts = msg.split(',');
                    parts.forEach(part => {
                        const [key, val] = part.split(':');
                        if (key === 'RSSI') rssi = parseInt(val);
                        if (key === 'RPM') rpm = parseInt(val);
                    });
                    GLOBAL_LATEST_RSSI = rssi;
                    
                } catch (e) { console.error('파싱 에러:', e); }
            
                // 서버 <-> 펌웨어 PWM 동기화 로직
            if (GLOBAL_STATE.targetPwm === 0 && rpm > 100) {
                 console.log("⚠️ [Sync] 아두이노가 혼자 돌고 있음 -> 정지 명령 재전송");
                 sendToTarget("PWM:0", "FW");
            }
                // 1-2. DB 저장
                const sql = `INSERT INTO sensor_logs (rssi, rpm) VALUES (?, ?)`;
                dbConnection.query(sql, [rssi, rpm], () => {});

                // WPF에게 보낼 때는 서버가 알고 있는 PWM 값을 합쳐서 보냄
                // FW가 보낸 RSSI, RPM + 서버가 기억하는 targetPwm
                const combinedData = `RSSI:${rssi},RPM:${rpm},PWM:${GLOBAL_STATE.targetPwm}`;                
                sendToTarget(combinedData, 'WPF'); 
                
                return; 
            }

        // ============================================
        // 2. WPF(모니터)가 보낸 명령 처리
        // ============================================
        console.log(`\n[${socket.clientType}->Server] 명령 수신: [${msg}]`);

        // PWM 명령이 오면 -> FW에게 전달
        if (msg.startsWith('PWM:')) {
                    const value = parseInt(msg.split(':')[1]);
                    if (!isNaN(value)) {
                        // 전역 변수 업데이트 (이제 모두가 이 값을 공유함)
                        GLOBAL_STATE.targetPwm = value; 
                        sendToTarget(msg, 'FW'); 
                    }
                    return;
                }

        switch (msg) {
            case 'AUTO_START': runAutoSequence(); break;
            
            case 'LED_ON': 
                sendToTarget("LED_ON", 'FW'); 
                break;
            
            case 'LED_OFF': 
                sendToTarget("LED_OFF", 'FW'); 
                break;
            
            // 기타 모터 제어 명령도 FW로 넘겨줌
            case 'MOTOR_RUN': sendToTarget("MOTOR_RUN", 'FW'); break;
            case 'EMERGENCY_STOP': sendToTarget("EMERGENCY_STOP", 'FW'); break;

            default: console.log(`⚠️ [System] 알 수 없는 명령: ${msg}`);
        }
    });

    // ----------------------------------------------------
    // [기능 D] 접속 종료 처리
    // ----------------------------------------------------
const handleDisconnect = () => {
        console.log(`\n❌ [Client] 접속 해제: ${socket.clientType}`);
        const index = connectedSockets.indexOf(socket);
        if (index > -1) connectedSockets.splice(index, 1);
    };

    socket.on('end', handleDisconnect);
    socket.on('error', (err) => handleDisconnect());
});

// ==========================================
// [5] 서버 실행
// ==========================================
server.listen(CONFIG.PORT, CONFIG.HOST, () => {
    console.log(`\n🚀 REMS Server Started on Port ${CONFIG.PORT}`);
    console.log(`-------------------------------------------`);
});