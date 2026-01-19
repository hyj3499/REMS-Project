using CommunityToolkit.Mvvm.ComponentModel;
using LiveChartsCore;
using LiveChartsCore.SkiaSharpView;
using LiveChartsCore.SkiaSharpView.Painting;
using SkiaSharp;
using System.Collections.ObjectModel;

namespace REMS.Client
{
    public partial class MainViewModel : ObservableObject
    {
        // 1. 온도 차트 데이터
        private readonly ObservableCollection<double> _tempValues;
        public ISeries[] TempSeries { get; set; }

        // 2. 모터 PDW(PWM) 차트 데이터
        private readonly ObservableCollection<double> _motorValues;
        public ISeries[] MotorSeries { get; set; }

        public MainViewModel()
        {
            // 1. 온도 데이터 초기화
            _tempValues = new ObservableCollection<double> { 20, 22, 25, 24, 26, 28, 30, 29, 28 };
            TempSeries = new ISeries[]
            {
                new LineSeries<double>
                {
                    Values = _tempValues,
                    Fill = new SolidColorPaint(SKColors.Cyan.WithAlpha(50)), // 반투명 채우기
                    GeometrySize = 0,
                    LineSmoothness = 1,
                    Stroke = new SolidColorPaint(SKColors.Cyan) { StrokeThickness = 3 },
                    Name = "Temperature"
                }
            };

            // 2. 모터 데이터 초기화 
            _motorValues = new ObservableCollection<double> { 0, 50, 80, 100, 100, 80, 60, 40, 0 };
            MotorSeries = new ISeries[]
            {
                new StepLineSeries<double> 
                {
                    Values = _motorValues,
                    Fill = new SolidColorPaint(SKColors.Orange.WithAlpha(50)),
                    GeometrySize = 0,
                    Stroke = new SolidColorPaint(SKColors.Orange) { StrokeThickness = 3 },
                    Name = "Motor Output (PWM)"
                }
            };
        }
    }
}