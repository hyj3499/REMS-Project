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

// ==========================================
// [4] 서버 메인 로직
// ==========================================
const server = net.createServer((socket) => {
    console.log(`\n✅ [Client] 새로운 접속: ${socket.remoteAddress}`);

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
            if (socket.writable) socket.write(`LOG:${msg}\n`);
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
    // [기능 B] 테스트용 데이터 전송 
    // ----------------------------------------------------
    const intervalId = setInterval(() => {
        // 1. 센서 데이터 생성
        const rssi = getRandomInt(-90, -40);
        const rpm = calculateRpm(state.targetPwm, state.isMotorRunning);

        // 2. WPF로 전송 (소켓이 연결된 상태일 때만)
        if (socket.writable) {
            const dataToSend = `RSSI:${rssi},RPM:${rpm},PWM:${state.targetPwm}\n`;
            socket.write(dataToSend);
        } else {
            clearInterval(intervalId); // 연결 끊기면 타이머 중지
            return;
        }

        // 3. DB 저장
        const sql = `INSERT INTO sensor_logs (rssi, rpm) VALUES (?, ?)`;
        dbConnection.query(sql, [rssi, rpm], (err) => {
            if (err) console.error('⚠️ [DB] 저장 실패:', err.message);
        });

        // 상태 표시 (콘솔 도배 방지용 한 줄 출력)
        process.stdout.write(`.`); 

    }, CONFIG.SIMULATION.INTERVAL_MS);


    // ----------------------------------------------------
    // [기능 C] 명령어 수신 및 처리
    // ----------------------------------------------------
    socket.on('data', (data) => {
        const command = data.toString().trim();
        console.log(`\n📩 명령 수신: [${command}]`);

        // PWM 명령 별도 처리 (파라미터가 있어서)
        if (command.startsWith('PWM:')) {
            const value = parseInt(command.split(':')[1]);
            if (!isNaN(value)) {
                state.targetPwm = value;
                console.log(`👉 [설정] 목표 속도 변경: ${state.targetPwm}%`);
            }
            return;
        }

        switch (command) {
            case 'AUTO_START':
                runAutoSequence();
                break;
            case 'MOTOR_RUN':
                state.isMotorRunning = true;
                console.log("👉 [상태] 모터 가동 ON");
                break;
            case 'EMERGENCY_STOP':
                state.isMotorRunning = false;
                console.log("👉 [상태] 모터 정지 OFF");
                break;
            case 'LED_ON':
                console.log("👉 [제어] LED ON");
                break;
            case 'LED_OFF':
                console.log("👉 [제어] LED OFF");
                break;
            default:
                console.log(`⚠️ 알 수 없는 명령: ${command}`);
        }
    });

    // ----------------------------------------------------
    // [기능 D] 접속 종료 처리
    // ----------------------------------------------------
    const handleDisconnect = () => {
        console.log(`\n❌ [Client] 접속 해제: ${socket.remoteAddress}`);
        clearInterval(intervalId); // 타이머 정리
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