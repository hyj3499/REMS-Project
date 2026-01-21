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

// 이벤트 기반 딜레이 함수
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
                clearTimeout(timer); // 타이머 취소
                reject(new Error("⚠️ 긴급 정지 (인터럽트 발생)"));
            }, { once: true }); // 한 번만 실행
        }
    });
};

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

        // 인터럽트
        autoSequenceController = new AbortController();
        const { signal } = autoSequenceController; 

        const sendLog = (msg) => sendToTarget(`LOG:${msg}`, 'WPF');
        
        const sendPwmToFw = (pwmValue) => {
            GLOBAL_STATE.targetPwm = pwmValue; // 1. 서버 기억
            sendToTarget(`PWM:${pwmValue}`, 'FW'); // 2. 아두이노 전송
        };

try {
            GLOBAL_STATE.isMotorRunning = true;

            sendPwmToFw(0);
            sendLog(`[AUTO] STEP1: 안전 점검 시작 (3초)`);
            
            // 딜레이 함수에 신호선(signal) 연결
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
            //인터럽트가 발생하면 여기로 즉시 점프
            console.log(`🛑 시퀀스 강제 중단: ${err.message}`);
            sendLog(`[STOP] 🛑 비상 정지 발동! 공정을 즉시 중단.`);
            sendPwmToFw(0); 

        } finally {
            GLOBAL_STATE.isAutoSequenceRunning = false;
            autoSequenceController = null; // 컨트롤러 폐기
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
                 console.log("⚠️ [Sync] 재동기화");
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
            
            case 'MOTOR_RUN': 
                            GLOBAL_STATE.isMotorRunning = true; 
                            sendToTarget("MOTOR_RUN", 'FW'); 
                            break;
            case 'EMERGENCY_STOP': 
                            console.log("[ALERT] 비상 정지 요청 수신!");
                            
                            // 현재 돌고 있는 시퀀스가 있다면 -> 폭파(abort)
                            if (autoSeㅇquenceController) {
                                autoSequenceController.abort(); // -> 즉시 catch 블록으로 이동!
                            }
                            
                            GLOBAL_STATE.isMotorRunning = false;
                            GLOBAL_STATE.targetPwm = 0; 
                            sendToTarget("EMERGENCY_STOP", 'FW'); 
                            sendToTarget("PWM:0", 'FW'); 
                            sendToTarget("LED_OFF", 'FW'); 
                            break;

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