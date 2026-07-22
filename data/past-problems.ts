/** 历年电赛赛题索引（本科组/高职组，来源：全国大学生电子设计竞赛官方赛题）。
 *  仅存题号与题名用于快速选题；完整题面需用户上传 PDF 或粘贴（题面版权归组委会）。 */

export interface PastProblem {
  code: string;     // A / B / C…
  title: string;
  group?: string;   // 本科组 / 高职组
  keywords?: string[];
}

export const PAST_PROBLEMS: Record<string, PastProblem[]> = {
  "2025": [
    { code: "A", title: "能量回馈的变流器负载试验装置", keywords: ["电力电子", "能量回馈", "变流器"] },
    { code: "B", title: "单相有源电力滤波实验装置", keywords: ["APF", "谐波补偿", "电力电子"] },
  ],
  "2024": [
    { code: "A", title: "多量程电流测量装置", keywords: ["电流测量", "自动量程", "仪器仪表"] },
    { code: "B", title: "三子微处理器协同系统", keywords: ["多机通信", "协同"] },
    { code: "C", title: "无线充电与传输系统", keywords: ["无线电能传输", "谐振"] },
    { code: "E", title: "自动追踪系统", keywords: ["控制", "追踪"] },
    { code: "H", title: "自动行驶小车", group: "本科组", keywords: ["小车", "循迹", "控制"] },
  ],
  "2023": [
    { code: "A", title: "运算放大器参数测量装置", keywords: ["运放参数", "增益带宽", "压摆率", "测量"] },
    { code: "B", title: "同轴电缆长度与终端负载检测装置", keywords: ["反射法", "TDR", "测量"] },
    { code: "C", title: "空地协同智能消防系统", keywords: ["无人机", "小车", "协同"] },
    { code: "D", title: "液体流速测量装置", keywords: ["流速", "超声", "测量"] },
    { code: "E", title: "运动目标控制与自动追踪系统", keywords: ["视觉", "云台", "追踪"] },
    { code: "F", title: "智能小车", keywords: ["小车", "控制"] },
    { code: "H", title: "信号分离装置", keywords: ["信号处理", "滤波", "分离"] },
  ],
  "2022": [
    { code: "A", title: "自动泊车系统", keywords: ["小车", "定位", "控制"] },
    { code: "B", title: "无线快速充电装置", keywords: ["无线充电", "电力电子"] },
    { code: "C", title: "空中侦察辅助系统", keywords: ["无人机", "图像"] },
    { code: "D", title: "数字-模拟混合信号处理装置", keywords: ["混合信号", "ADC", "DAC"] },
    { code: "E", title: "信号调制方式识别与参数估计装置", keywords: ["调制识别", "信号处理"] },
    { code: "F", title: "跳频通信系统", keywords: ["跳频", "通信"] },
    { code: "H", title: "三相 AC-DC 变换电路", keywords: ["三相", "整流", "电力电子"] },
  ],
  "2021": [
    { code: "A", title: "信号失真度测量装置", keywords: ["THD", "失真度", "测量"] },
    { code: "B", title: "三相逆变电源及其并联运行系统", keywords: ["三相逆变", "并联"] },
    { code: "C", title: "三端口 DC-DC 变换器", keywords: ["DC-DC", "多端口"] },
    { code: "D", title: "基于自由摆的平板控制系统", keywords: ["控制", "平衡"] },
    { code: "E", title: "数字信号处理与显示", keywords: ["DSP", "显示"] },
    { code: "F", title: "智能送药小车", keywords: ["小车", "视觉", "路径"] },
    { code: "G", title: "植保飞行器", keywords: ["无人机"] },
  ],
  "2020": [
    { code: "A", title: "电感电容测量装置", keywords: ["LC 测量", "仪器仪表"] },
    { code: "B", title: "健身器械运动状态检测装置", keywords: ["传感", "检测"] },
    { code: "C", title: "线路负载及故障检测装置", keywords: ["故障检测", "测量"] },
    { code: "D", title: "简易无接触温度测量与身份识别装置", keywords: ["红外测温", "识别"] },
    { code: "E", title: "放大器非线性失真研究装置", keywords: ["失真", "放大器"] },
    { code: "F", title: "紫外光通信系统", keywords: ["光通信"] },
  ],
  "2019": [
    { code: "A", title: "电动小车动态无线充电系统", keywords: ["无线充电", "小车"] },
    { code: "B", title: "巡线机器人", keywords: ["机器人", "巡线"] },
    { code: "C", title: "线路负载及故障检测装置", keywords: ["故障检测"] },
    { code: "D", title: "简易电路特性测试仪", keywords: ["测量", "仪器"] },
    { code: "E", title: "简易频率特性测试仪", keywords: ["频率特性", "扫频"] },
    { code: "F", title: "纸张计数显示装置", keywords: ["检测", "计数"] },
  ],
};

export const PROBLEM_YEARS = Object.keys(PAST_PROBLEMS).sort((a, b) => Number(b) - Number(a));
