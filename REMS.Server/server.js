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

    // ----------------------------------------------------
    // [기능 1] 1초마다 데이터 생성 -> WPF 전송 -> DB 저장
    // ----------------------------------------------------
    const intervalId = setInterval(() => {
        // 1. 테스트용 가짜 센서 데이터 생성 (랜덤)
        const rssi = Math.floor(Math.random() * ( -40 - (-90) + 1)) + -90;
        const rpm = Math.floor(Math.random() * (3000 - 1000 + 1)) + 1000;
        
        // 2. WPF로 전송 (화면에 그리기용)
        const dataToSend = `RSSI:${rssi},RPM:${rpm}\n`;
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

        // 추가: 모터 제어 명령 수신 로그
        else if (command === 'MOTOR_RUN') {
            console.log("👉 [제어] 모터 가동 시작");
        }
        else if (command === 'MOTOR_PAUSE') {
            console.log("👉 [제어] 모터 정지");
        }
        else if (command.startsWith('PWM:')) {
             console.log(`👉 [제어] 속도 설정: ${command.split(':')[1]}%`);
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