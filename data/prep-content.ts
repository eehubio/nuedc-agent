/** 首页策展内容：备赛清单 / 知识点 / 典型方向。
 *  这里是学习指引类静态内容（非平台数据统计），可按年度更新。 */

export const PREP_TASKS = [
  "学习：锁相放大器原理",
  "阅读：本年度器件清单解析",
  "搭建：DDS + ADC 测试平台",
  "练习：FFT 与相位计算",
  "完成：自动量程算法",
  "调试：同步检波代码",
];

export const KNOWLEDGE_POINTS = [
  { t: "锁相放大原理与实现", heat: "微弱信号检测核心" },
  { t: "自动增益控制（AGC）", heat: "幅度自适应" },
  { t: "SPWM 三相逆变技术", heat: "电力电子类" },
  { t: "FFT 频谱分析", heat: "信号测量必备" },
  { t: "同步检波与相干解调", heat: "相位测量" },
];

export const TYPICAL_DIRECTIONS = [
  {
    name: "信号测量平台", icon: "📡", tags: ["幅度/相位/频率测量", "通用仪器"],
    seed: "设计一个信号参数测量平台：测量 1Hz~1MHz 正弦信号的幅度（10mVpp~10Vpp）、频率、相位差与 RMS 值，要求自动量程，测量误差幅度≤1%、相位≤1°，结果本地显示。",
  },
  {
    name: "小车运动控制系统", icon: "🚗", tags: ["编码器/闭环", "PID 算法"],
    seed: "设计一个智能小车运动控制系统：循迹行驶并识别路径上的标志物，速度闭环控制，直线段速度≥1m/s，弯道不冲出赛道，到达指定点停车误差≤5cm。",
  },
  {
    name: "无人机任务系统", icon: "🚁", tags: ["自主识别", "坐标定位"],
    seed: "设计一个无人机自主任务系统：室内定高悬停，识别地面目标并飞抵目标上方投放标记，全程无人工干预，悬停高度误差≤10cm。",
  },
  {
    name: "数字电源", icon: "🔋", tags: ["DC-DC", "效率/纹波"],
    seed: "设计一个数字控制 DC-DC 变换器：输入 15~25V，输出 10V 可调，最大输出电流 2A，效率≥90%，负载调整率≤0.5%，具备过流保护并显示电压电流。",
  },
  {
    name: "磁参数测量系统", icon: "🧲", tags: ["B-H 曲线", "损耗测试"],
    seed: "设计一个磁性材料参数测量装置：测量磁环的 B-H 曲线与磁芯损耗，激励频率 1k~100kHz 可调，绘制曲线并计算损耗，误差≤5%。",
  },
];

/** 首页功能入口卡（导航到对应页面） */
export const FEATURES: { key: string; name: string; desc: string; icon: string; color: string }[] = [
  { key: "forecast", name: "题目预测", desc: "AI 预测题目方向与考点", icon: "📊", color: "#f59e0b" },
  { key: "solution", name: "方案生成", desc: "根据需求生成完整方案", icon: "🧠", color: "#22c55e" },
  { key: "modules", name: "模块选型", desc: "智能推荐器件与模块", icon: "🔲", color: "#3b82f6" },
  { key: "code", name: "代码生成", desc: "一键生成算法与驱动", icon: "⌨️", color: "#7c3aed" },
  { key: "debug", name: "调试助手", desc: "故障定位与测量指引", icon: "🔬", color: "#0ea5e9" },
];

export const CATEGORY_FILTERS: { key: string; label: string }[] = [
  { key: "", label: "全部" },
  { key: "signal", label: "信号调理" },
  { key: "adc", label: "数据转换" },
  { key: "mcu", label: "控制器" },
  { key: "sensor", label: "传感器" },
  { key: "vision", label: "视觉" },
  { key: "actuator", label: "执行机构" },
  { key: "power", label: "电源管理" },
  { key: "comm", label: "通信模块" },
];

export const CAT_ICON: Record<string, string> = {
  signal: "〰️", adc: "🎚️", mcu: "🎛️", sensor: "🌡️", vision: "📷",
  actuator: "⚙️", power: "🔋", comm: "📶",
};
