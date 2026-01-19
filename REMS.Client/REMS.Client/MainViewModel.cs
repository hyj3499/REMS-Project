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
        // [1] 차트 데이터
        private readonly ObservableCollection<double> _rssiValues;
        public ISeries[] RssiSeries { get; set; }

        private readonly ObservableCollection<double> _rpmValues;
        public ISeries[] RpmSeries { get; set; }
        public Axis[] XAxes { get; set; }

        // [2] 상태 데이터
        [ObservableProperty]
        private bool _isLedOn;

        [ObservableProperty]
        private int _motorSpeed = 50;

        [ObservableProperty]
        private string _logText = "";

        [ObservableProperty]
        private int _wifiRssi = -100;

        [ObservableProperty]
        private int _currentRpm = 0;

        // [3] 통신용 변수
        private TcpClient _client;
        private StreamReader _reader;
        private StreamWriter _writer;

        [ObservableProperty]
        private bool _isConnected = false;

        public MainViewModel()
        {

            _rssiValues = new ObservableCollection<double>();
            _rpmValues = new ObservableCollection<double>();

            // 차트가 비어있으면 에러가 나니까, 0으로 채워진 빈 데이터를 미리 30개 정도 넣어둠
            for (int i = 0; i < 30; i++)
            {
                _rssiValues.Add(-100); // RSSI 기본값은 낮게
                _rpmValues.Add(0);     // RPM 기본값 0
            }

            RssiSeries = new ISeries[]            {
                new LineSeries<double>
                {
                    Values = _rssiValues,
                    Fill = null, // 선만 보이게 (채우기 없음)
                    GeometrySize = 5, // 점 크기
                    Stroke = new SolidColorPaint(SKColors.LimeGreen) { StrokeThickness = 2 }, // 초록색 선
                    Name = "Wi-Fi RSSI (dBm)"
                }
            };

            RpmSeries = new ISeries[]
                        {
                new LineSeries<double> // 실제 속도는 부드러우니까 LineSeries 추천
                {
                    Values = _rpmValues,
                    Fill = new SolidColorPaint(SKColors.Orange.WithAlpha(50)),
                    GeometrySize = 0,
                    Stroke = new SolidColorPaint(SKColors.Orange) { StrokeThickness = 2 },
                    Name = "Actual RPM"
                }
            };

            // X축
            XAxes = new Axis[] {
                new Axis {
                 NamePaint = new SolidColorPaint(SKColors.Gray),
                 LabelsPaint = new SolidColorPaint(SKColors.Gray),
                 TextSize = 11,
                 Labeler = v => DateTime.Now.AddSeconds(v - 30).ToString("HH:mm:ss")
                 }
            };

            AddLog("[SYS] REMS 클라이언트 시작됨");
            AddLog("[SYS] 모니터링 시스템 대기 중...");
        }

        // [4] 서버 연결 함수
        public async void ConnectToServer(string ip, int port)
        {
            if (IsConnected) return; // 이미 연결됐으면 패스

            try
            {
                AddLog($"[NET] 서버({ip}:{port}) 연결 시도...");

                _client = new TcpClient();
                await _client.ConnectAsync(ip, port); // 비동기 연결 시도

                _reader = new StreamReader(_client.GetStream());
                _writer = new StreamWriter(_client.GetStream()) { AutoFlush = true };
                IsConnected = true;

                AddLog("[NET] ✅ 서버 연결 성공!");

                // 연결되자마자 데이터 수신 시작 (별도 스레드)
                _ = Task.Run(ReceiveDataLoop);
            }
            catch (Exception ex)
            {
                AddLog($"[NET] ❌ 서버 연결 실패: {ex.Message}");
            }
        }

        // [5] 데이터 수신 루프
        private async Task ReceiveDataLoop()
        {
            try
            {
                while (IsConnected)
                {
                    // 서버가 보낸 한 줄 읽기
                    string message = await _reader.ReadLineAsync();
                    if (message == null) break;

                    // UI 업데이트는 메인 스레드에서 해야 함! (중요)
                    Application.Current.Dispatcher.Invoke(() =>
                    {
                        ParseAndVisualize(message); //데이터 해석기 호출
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

        // [6] 데이터 해석기 (Parsing)
        private void ParseAndVisualize(string rawData)
        {
            // rawData 예시: "RSSI:-65,RPM:1250"
            try
            {
                var parts = rawData.Split(','); // 쉼표로 분리
                foreach (var part in parts)
                {
                    var keyValue = part.Split(':'); // 콜론으로 분리
                    if (keyValue.Length != 2) continue;

                    string key = keyValue[0];            // "RSSI" 또는 "RPM"
                    double value = double.Parse(keyValue[1]); // 숫자값

                    if (key == "RSSI")
                    {
                        // 1. 차트 업데이트 (오래된 데이터 삭제 후 추가)
                        if (_rssiValues.Count > 30) _rssiValues.RemoveAt(0);
                        _rssiValues.Add(value);

                        // 2. [중요] UI 게이지바용 변수 업데이트
                        WifiRssi = (int)value;
                    }
                    else if (key == "RPM")
                    {
                        if (_rpmValues.Count > 30) _rpmValues.RemoveAt(0);
                        _rpmValues.Add(value);
                        CurrentRpm = (int)value;
                    }
                }
            }
            catch
            {
                // 데이터 파싱 에러 무시
            }
        }

        // [7] 서버로 명령 보내기 (LED, MOTOR 제어)
        public void SendCommand(string command)
        {
            if (IsConnected && _writer != null)
            {
                _writer.WriteLine(command); // 서버로 전송!
                AddLog($"[TX] 명령 전송: {command}");
            }
        }

        // LED ON/OFF UI
        [RelayCommand]
        public void TurnLedOn()
        {
            if (!IsLedOn)
            {
                IsLedOn = true;         // UI에 빨간불 켜기
                SendCommand("LED_ON");  // 서버 전송
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

        // MOTOR UI
        partial void OnMotorSpeedChanged(int value)
        {
            // 슬라이더를 움직이면 "PWM:50" 같은 형식으로 서버에 전송
            SendCommand($"PWM:{value}");
        }

        [RelayCommand]
        public void RunMotor()
        {
            SendCommand("MOTOR_RUN");
        }

        [RelayCommand]
        public void PauseMotor()
        {
            SendCommand("MOTOR_PAUSE");
        }

        [RelayCommand]
        public void EmergencyStop()
        {
            SendCommand("EMERGENCY_STOP");
            MotorSpeed = 0; // 속도도 0으로 초기화
            TurnLedOff();
        }

        // 로그 추가 헬퍼
        private void AddLog(string msg)
        {
            string time = DateTime.Now.ToString("HH:mm:ss");
            LogText = $"[{time}] {msg}\n" + LogText; // 최신 로그가 위로 오게
        }
    }
}