using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using LiveChartsCore;
using LiveChartsCore.SkiaSharpView;
using LiveChartsCore.SkiaSharpView.Painting;
using SkiaSharp;
using System;
using System.Collections.ObjectModel;
using System.IO;
using System.Net.Sockets;       // 소켓 통신용
using System.Threading.Tasks;   // 비동기 작업용
using System.Windows;           // UI 업데이트용

namespace REMS.Client
{
    public partial class MainViewModel : ObservableObject
    {
        // ==========================================
        // [1] 차트 및 UI 데이터 설정
        // ==========================================
        private readonly ObservableCollection<double> _rssiValues;
        private readonly ObservableCollection<double> _rpmValues;

        public ISeries[] RssiSeries { get; set; }
        public ISeries[] RpmSeries { get; set; }
        public Axis[] XAxes { get; set; }

        // ==========================================
        // [2] 상태 데이터
        // ==========================================
        [ObservableProperty] private string _ipAddress = "127.0.0.1"; // 연결 IP
        [ObservableProperty] private int _port = 5000;                // 연결 Port
        [ObservableProperty] private bool _isConnected = false;
        
        [ObservableProperty] private bool _isLedOn;
        [ObservableProperty] private string _logText = "";
        
        [ObservableProperty] private int _wifiRssi = -100;
        [ObservableProperty] private int _currentRpm = 0;

        [ObservableProperty] private int _motorSpeed = 0;
        private bool _isServerUpdate = false;

        // ==========================================
        // [3] 통신용 변수
        // ==========================================
        private TcpClient _client;
        private StreamReader _reader;
        private StreamWriter _writer;


        // ==========================================
        // [4] 생성자 (초기화)
        // ==========================================
        public MainViewModel()
        {

            _rssiValues = new ObservableCollection<double>();
            _rpmValues = new ObservableCollection<double>();

            for (int i = 0; i < 30; i++)
            {
                _rssiValues.Add(-100); 
                _rpmValues.Add(0); 
            }

            RssiSeries = new ISeries[]            
            {
                new LineSeries<double>
                {
                    Values = _rssiValues,
                    Fill = null,
                    GeometrySize = 0, 
                    Stroke = new SolidColorPaint(SKColors.DeepSkyBlue) { StrokeThickness = 2 },
                    Name = "Wi-Fi RSSI (dBm)"
                }
            };

            RpmSeries = new ISeries[]
            {
                new LineSeries<double>
                {
                    Values = _rpmValues,
                    Fill = new SolidColorPaint(SKColors.Orange.WithAlpha(50)),
                    GeometrySize = 0,
                    Stroke = new SolidColorPaint(SKColors.Orange) { StrokeThickness = 2 },
                    Name = "Actual RPM"
                }
            };

            // X축
            XAxes = new Axis[] 
            {
                new Axis {
                 NamePaint = new SolidColorPaint(SKColors.Gray),
                 LabelsPaint = new SolidColorPaint(SKColors.Gray),
                 TextSize = 11,
                 Labeler = v => DateTime.Now.AddSeconds(v - 30).ToString("HH:mm:ss")
                 }
            };

            AddLog("[SYS] 클라이언트가 시작되었습니다.");
        }

        // ==========================================
        // [5] Commands (버튼 이벤트 핸들러)
        // ==========================================
        [RelayCommand]
        public async Task Connect()
        {
            if (IsConnected) return;

            try
            {
                AddLog($"[NET] 서버({IpAddress}:{Port}) 연결 시도 중...");

                _client = new TcpClient();
                await _client.ConnectAsync(IpAddress, Port);

                _reader = new StreamReader(_client.GetStream());
                _writer = new StreamWriter(_client.GetStream()) { AutoFlush = true };

                IsConnected = true;
                AddLog("[NET] ✅ 서버 연결 성공!");

                // 수신 루프 시작 (Fire and Forget)
                _ = ReceiveDataLoop();
            }
            catch (Exception ex)
            {
                AddLog($"[NET] ❌ 연결 실패: {ex.Message}");
                IsConnected = false;
            }
        }

        [RelayCommand]
        public void TurnLedOn()
        {
            if (!IsLedOn)
            {
                IsLedOn = true;         
                SendCommand("LED_ON");
            }
        }

        [RelayCommand]
        public void TurnLedOff()
        {
            if (IsLedOn)
            {
                IsLedOn = false;
                SendCommand("LED_OFF");
            }
        }

        [RelayCommand]
        public void RunMotor()
        {
            SendCommand("MOTOR_RUN");
        }

        [RelayCommand]
        public void PauseMotor()
        {
            SendCommand("EMERGENCY_STOP");
            MotorSpeed = 0; 
            TurnLedOff();
        }

        [RelayCommand]
        public void AutoStart()
        {
            SendCommand("AUTO_START");
            AddLog("[SYS] 자동 공정 시퀀스 시작 명령을 전송했습니다.");
        }
 
        // ==========================================
        // [6] 데이터 송수신
        // ==========================================
        private async Task ReceiveDataLoop()
        {
            try
            {
                while (IsConnected)
                {
                    // 서버가 보낸 한 줄 읽기
                    string message = await _reader.ReadLineAsync();
                    if (message == null) break;

                    Application.Current.Dispatcher.Invoke(() =>
                    {
                        // Node.js 서버의 로그 읽기 (오토 시퀀스)
                        if (message.StartsWith("LOG:"))
                        {
                            string logContent = message.Substring(4);
                            AddLog(logContent);
                        }
                        else
                        {
                            // 기존 센서 데이터(RSSI, RPM) 처리
                            ParseAndVisualize(message);
                        }
                    });
                }
            }
            catch (Exception ex)
            {
                Application.Current.Dispatcher.Invoke(() => AddLog("[NET] ❌ 서버 연결 실패"));
            }
            finally
            {
                _client?.Close();
                IsConnected = false;
            }
        }

        //데이터 해석기 (Parsing)
        private void ParseAndVisualize(string rawData)
        {
            // rawData 예시: "RSSI:-65,RPM:1250" -> ,와 ; 분리 후 데이터 추출
            try
            {
                var parts = rawData.Split(',');
                foreach (var part in parts)
                {
                    var keyValue = part.Split(':');
                    if (keyValue.Length != 2) continue;

                    string key = keyValue[0];           
                    double value = double.Parse(keyValue[1]);

                    if (key == "RSSI")
                    {
                        // 차트 업데이트 (오래된 데이터 삭제 후 추가)
                        if (_rssiValues.Count > 30) _rssiValues.RemoveAt(0);
                        _rssiValues.Add(value);
                        WifiRssi = (int)value;
                    }
                    else if (key == "RPM")
                    {
                        if (_rpmValues.Count > 30) _rpmValues.RemoveAt(0);
                        _rpmValues.Add(value);
                        CurrentRpm = (int)value;
                    }
                    else if (key == "PWM")
                    {
                        _isServerUpdate = true;
                        MotorSpeed = (int)value;
                        _isServerUpdate = false;
                    }
                }
            }
            catch
            {
                // 데이터 파싱 에러 무시
            }
        }
        public void SendCommand(string command)
        {
            if (IsConnected && _writer != null)
            {
                _writer.WriteLine(command); // 서버로 전송!
                AddLog($"[TX] 명령 전송: {command}");
            }
        }
        partial void OnMotorSpeedChanged(int value)
        {
            if (_isServerUpdate) return;
            SendCommand($"PWM:{value}");
        }

        // 로그 추가
        private void AddLog(string msg)
        {
            string time = DateTime.Now.ToString("HH:mm:ss");
            LogText = $"[{time}] {msg}\n" + LogText; // 최신 로그가 위로 오게
        }
    }
}