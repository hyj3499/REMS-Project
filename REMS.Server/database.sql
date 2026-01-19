/* REMS 프로젝트 데이터베이스 설계도 */

/* 1. 데이터베이스 생성 */
CREATE DATABASE IF NOT EXISTS rems_db;

/* 2. 사용 */
USE rems_db;

/* 3. 테이블 생성 */
CREATE TABLE IF NOT EXISTS sensor_logs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    temperature FLOAT COMMENT '온도 데이터',
    motor_load INT COMMENT '모터 부하(%)',
    created_at DATETIME DEFAULT NOW() COMMENT '생성 시간'
);