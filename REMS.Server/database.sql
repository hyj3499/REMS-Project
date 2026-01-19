/* REMS 프로젝트 데이터베이스 설계도 (수정됨) */

/* 1. 데이터베이스 생성 */
CREATE DATABASE IF NOT EXISTS rems_db;

/* 2. 사용 */
USE rems_db;

/* 3. 테이블 생성 (기존 테이블이 있다면 삭제하고 새로 생성) */
DROP TABLE IF EXISTS sensor_logs;

CREATE TABLE sensor_logs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    rssi INT COMMENT 'Wi-Fi 신호 강도 (dBm)',    
    rpm INT COMMENT '모터 회전 속도 (RPM)',    
    created_at DATETIME DEFAULT NOW() COMMENT '생성 시간'
);