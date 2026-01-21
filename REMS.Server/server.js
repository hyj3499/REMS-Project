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
    SIMULATION: {
        INTERVAL_MS: 200,      // 데이터 전송 주기 (0.2초)
        RPM_MULTIPLIER: 30,    
        MAX_NOISE: 20          
    }
};

const connectedSockets = [];
let GLOBAL_LATEST_RSSI = -100;

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

// 랜덤 정수 생성 (min ~ max)
const getRandomInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

// RPM 계산 로직
const calculateRpm = (targetPwm, isRunning) => {
    if (!isRunning) return 0;
    
    const baseRpm = targetPwm * CONFIG.SIMULATION.RPM_MULTIPLIER;
    const noise = getRandomInt(-CONFIG.SIMULATION.MAX_NOISE, CONFIG.SIMULATION.MAX_NOISE);
    let rpm = baseRpm + noise;
    
    return rpm < 0 ? 0 : rpm; // 음수 방지
};

// 타겟 지정 전송 함수 (일방향 통신)
// targetType: 'FW' (Firmware) 또는 'WPF' (Client) 
function sendToTarget(message, targetType) {
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

    // [기본 설정] 일단 접속하면 'WPF'라고 가정 (나중에 RSSI 보내면 FW로 바뀜)
    socket.clientType = 'WPF'; 
    connectedSockets.push(socket);

    // 클라이언트별 상태 변수
    let state = {
        targetPwm: 50,
        isMotorRunning: false,
        isAutoSequenceRunning: false
    };

    // ----------------------------------------------------
    // [기능 A] 자동 공정 시퀀스 (Auto Sequence)
    // ----------------------------------------------------
    async function runAutoSequence() {
        if (state.isAutoSequenceRunning) return; // 중복 실행 방지
        state.isAutoSequenceRunning = true;

        const sendLog = (msg) => {
            // 로그는 모니터(WPF)에게만 전송
            sendToTarget(`LOG:${msg}`, 'WPF');
        };

        try {
            // STEP 1: 안전 점검
            state.isMotorRunning = true;
            state.targetPwm = 0;
            sendLog(`[AUTO] STEP1: 안전 점검 시작 (3초)`);
            
            for (let i = 3; i > 0; i--) {
                sendLog(`[AUTO] 장비 점검 중... ${i}초 남음`);
                await delay(1000);
            }

            // STEP 2: 가속
            state.targetPwm = 30;
            sendLog(`[AUTO] STEP2: 모터 가속 시작 PWM 30%`);
            for (let i = 1; i <= 5; i++) {
                sendLog(`[AUTO] 가속 유지 중... (${i}/5초)`);
                await delay(1000);
            }

            // STEP 3: 고속 공정
            state.targetPwm = 85;
            sendLog(`[AUTO] STEP3: 메인 공정 진입 PWM 85%`);
            for (let i = 1; i <= 10; i++) {
                if (i === 1 || i % 5 === 0) {
                    sendLog(`[AUTO] 고속 운전 중... (${i}/10초)`);
                }
                await delay(1000);
            }

            // STEP 4: 종료
            state.targetPwm = 15;
            sendLog(`[AUTO] STEP4: 공정 종료 및 감속 PWM 15%`);
            await delay(3000);

            // 완료
            state.isMotorRunning = false;
            state.targetPwm = 0;
            sendLog("[DONE] ✅ 모든 자동 공정 시퀀스 완료.");

        } catch (err) {
            sendLog("[ERR] ❌ 시퀀스 실행 중 오류 발생");
            console.error(err);
        } finally {
            state.isAutoSequenceRunning = false;
        }
    }

    // ----------------------------------------------------
    // [기능 B] 데이터 브로드캐스트 (전송 루프)
    // ----------------------------------------------------
    const intervalId = setInterval(() => {
            // ESP8266이 보내준 전역 변수값
            const rssi = GLOBAL_LATEST_RSSI; 
            // RPM은 시뮬레이션 값 유지
            const rpm = calculateRpm(state.targetPwm, state.isMotorRunning);

            if (socket.writable) {
            // 모니터(WPF)인 경우에만 데이터를 보냄 (FW(펌웨어)는 이 데이터를 받을 필요가 없으므로 전송 X)
            if (socket.clientType === 'WPF') {
                const dataToSend = `RSSI:${rssi},RPM:${rpm},PWM:${state.targetPwm}\n`;
                socket.write(dataToSend);
                }
            } else {
                clearInterval(intervalId);
                return;
            }

            // DB 저장
            const sql = `INSERT INTO sensor_logs (rssi, rpm) VALUES (?, ?)`;
            dbConnection.query(sql, [rssi, rpm], (err) => {
                if (err) console.error('⚠️ [DB] 저장 실패:', err.message);
            });


        }, CONFIG.SIMULATION.INTERVAL_MS);

    // ----------------------------------------------------
    // [기능 C] 데이터 수신 (Firmware -> Server)
    // ----------------------------------------------------
    socket.on('data', (data) => {
            const msg = data.toString().trim();

            if (msg === "") return; //메시지가 비어있으면 그냥 무시하고 함수 종료
            
        // 1. RSSI 처리 (이걸 보내는 애는 무조건 FW)
        if (msg.startsWith('RSSI:')) {
            // 여기서 소켓의 정체를 'FW'로 확정
            socket.clientType = 'FW'; 

            const value = parseInt(msg.split(':')[1]);
            if (!isNaN(value)) {
                GLOBAL_LATEST_RSSI = value; 
                console.log(`[FW] RSSI 수신: ${value}`); 
            }
            return; 
        }

            // 기존 명령어 처리
            console.log(`\n📩 명령 수신: [${msg}]`);

        // 2. WPF에서 온 제어 명령 처리
        if (msg.startsWith('PWM:')) {
            const value = parseInt(msg.split(':')[1]);
            if (!isNaN(value)) {
                state.targetPwm = value;
                console.log(`👉 [설정] 목표 속도 변경: ${state.targetPwm}%`);
            }
            return;
        }

            switch (msg) {
                case 'AUTO_START': runAutoSequence(); break;
                case 'MOTOR_RUN': state.isMotorRunning = true; break;
                case 'EMERGENCY_STOP': state.isMotorRunning = false; break;
            
            // LED 제어 명령은 'FW'에게만 전달 (Unicast)
            case 'LED_ON': 
                console.log("👉 [제어] FW에게 LED ON 명령 전송"); 
                sendToTarget("LED_ON", 'FW'); 
                break;
            
            case 'LED_OFF': 
                console.log("👉 [제어] FW에게 LED OFF 명령 전송"); 
                sendToTarget("LED_OFF", 'FW'); 
                break;
                
                default: console.log(`⚠️ 알 수 없는 명령: ${msg}`);
            }
        });

    // ----------------------------------------------------
    // [기능 D] 접속 종료 처리
    // ----------------------------------------------------
const handleDisconnect = () => {
        console.log(`\n❌ [Client] 접속 해제: ${socket.remoteAddress}`);
        clearInterval(intervalId);
        
        // [추가] 접속자 명단에서 삭제
        const index = connectedSockets.indexOf(socket);
        if (index > -1) {
            connectedSockets.splice(index, 1);
        }
    };

    socket.on('end', handleDisconnect);
    socket.on('error', (err) => {
        console.log(`\n⚠️ [Net] 통신 에러: ${err.message}`);
        handleDisconnect();
    });
});

// ==========================================
// [5] 서버 실행
// ==========================================
server.listen(CONFIG.PORT, CONFIG.HOST, () => {
    console.log(`\n🚀 REMS Server Started on Port ${CONFIG.PORT}`);
    console.log(`-------------------------------------------`);
});