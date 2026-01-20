const net = require('net');      // 소켓 통신 모듈 (WPF 연결용)
const mysql = require('mysql2'); // MySQL DB 모듈 (데이터 저장용)


// ==========================================
// [1] MySQL 데이터베이스 연결 설정
// ==========================================
const dbConnection = mysql.createConnection({
    host: 'localhost',      
    user: 'root',           
    password: '1234',       
    database: 'rems_db'    
});

// DB 접속 시도
dbConnection.connect((err) => {
    if (err) {
        console.error('❌ DB 연결 실패:', err.message);
        return; 
    }
    console.log('✅ MySQL DB에 성공적으로 연결되었습니다!');
});

// ==========================================
// [2] TCP 서버 설정 (포트: 5000)
// ==========================================
const PORT = 5000;
const HOST = '0.0.0.0'; // 모든 IP에서 접속 허용

const server = net.createServer((socket) => {
    console.log(`✅ 새로운 클라이언트 접속: ${socket.remoteAddress}`);

    let targetPwm = 50; 
    let isMotorRunning = false;
    const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));


    // 자동 시퀀스 비동기 함수 정의
    async function runAutoSequence() {
        try {
            // Step 1
            isMotorRunning = true;
            targetPwm = 0;
            socket.write(`LOG:[AUTO] STEP1: 안전 점검 시작\n`);
            for (let i = 3; i > 0; i--) {
                socket.write(`LOG:[AUTO] 장비 점검 중... (${i}초/3초 경과)\n`);
                await delay(1000);
            }

            // Step 2
            targetPwm = 30;
            socket.write(`LOG:[AUTO] STEP2: 모터 가속 [PWM 30%]\n`);
            for (let i = 1; i <= 5; i++) {
                socket.write(`LOG:[AUTO] 가속 유지 중... (${i}/5초 경과)\n`);
                await delay(1000);
            }

            // Step 3
            targetPwm = 85;
            socket.write(`LOG:[AUTO] STEP3: 메인 공정 진입 [PWM 85%]\n`);
            for (let i = 1; i <= 10; i++) {
                if (i % 5 === 0 || i === 1) {
                    socket.write(`LOG:[AUTO] 고속 운전 중... (${i}/10초 경과)\n`);
                }
                await delay(1000);
            }

            // Step 4 & 완료
            targetPwm = 15;
            socket.write(`LOG:[AUTO] STEP4: 공정 종료 및 감속 시작 [PWM 15%]\n`);
            await delay(3000);

            isMotorRunning = false;
            targetPwm = 0;
            socket.write("LOG:[AUTO] 모든 자동 공정 시퀀스가 정상 종료되었습니다.\n");

        } catch (err) {
            socket.write("LOG:[AUTO] ❌ 시퀀스 수행 중 오류 발생\n");
        }
    }

    // ----------------------------------------------------
    // [기능 1] 1초마다 데이터 생성 -> WPF 전송 -> DB 저장
    // ----------------------------------------------------
    const intervalId = setInterval(() => {
        // 1. 테스트용 가짜 센서 데이터 생성 (랜덤)
        const rssi = Math.floor(Math.random() * ( -40 - (-90) + 1)) + -90;
    // 2. [변경] PWM 값에 비례하는 가짜 RPM 생성
        // 모터가 꺼져있으면 0, 켜져있으면 PWM * 30 (최대 3000 RPM 가정) + 약간의 오차
        let rpm = 0;
        if (isMotorRunning) {
            const baseRpm = targetPwm * 30; // 100%일 때 3000 RPM
            const noise = Math.floor(Math.random() * 40) - 20; // ±20 오차 추가
            rpm = baseRpm + noise;
            if (rpm < 0) rpm = 0;
        }
        
        // 2. WPF로 전송 (화면에 그리기용)
        const dataToSend = `RSSI:${rssi},RPM:${rpm},PWM:${targetPwm}\n`;
        socket.write(dataToSend);
        
        // 3. MySQL DB에 저장
        const sql = `INSERT INTO sensor_logs (rssi, rpm) VALUES (?, ?)`;        
        
        dbConnection.query(sql, [rssi, rpm], (err, result) => {
            if (err) {
                console.log('⚠️ DB 저장 실패:', err.message);
            } else {
                console.log(`💾 DB Saved: RSSI=${rssi}dBm, RPM=${rpm}`);            }
        });


        // 서버 화면에 점(.)을 찍어서 작동 중임을 표시
        process.stdout.write(`.`); 

    }, 200); // 1초(1000ms) 간격


    // ----------------------------------------------------
    // [기능 2] WPF에서 보낸 명령 받기 (LED 제어 등)
    // ----------------------------------------------------
    socket.on('data', (data) => {
        const command = data.toString().trim(); // 공백 제거
        console.log(`\n📩 명령 수신: [${command}]`); 

        if (command === 'LED_ON') {
            console.log("👉 [제어] LED를 켭니다 (ON)");

        } else if (command === 'LED_OFF') {
            console.log("👉 [제어] LED를 끕니다 (OFF)");
        }
        if (command === 'AUTO_START') {
            runAutoSequence(); 
        }
        // 추가: 모터 제어 명령 수신 로그
        if (command === 'MOTOR_RUN') {
            isMotorRunning = true;
            console.log("👉 [상태] 모터 가동 (isMotorRunning = true)");
        } 
        else if (command === 'EMERGENCY_STOP') {
            isMotorRunning = false;
            console.log("👉 [상태] 모터 정지 (isMotorRunning = false)");
        }
        else if (command.startsWith('PWM:')) {
            const receivedValue = command.split(':')[1];
            targetPwm = parseInt(receivedValue);
            console.log(`👉 [설정] 목표 속도: ${targetPwm}%`);
        }
    });

    // ----------------------------------------------------
    // [기능 3] 접속 종료 처리
    // ----------------------------------------------------
    socket.on('end', () => {
        console.log('\n❌ 클라이언트 접속 해제');
        clearInterval(intervalId); // 데이터 전송 타이머 중지 (필수!)
    });

    socket.on('error', (err) => {
        console.log(`\n⚠️ 통신 에러: ${err.message}`);
        clearInterval(intervalId);
    });
});

// 서버 가동 시작
server.listen(PORT, HOST, () => {
    console.log(`🚀 Node.js 서버가 포트 ${PORT}에서 대기 중입니다...`);
    console.log(`---------------------------------------------------`);
});