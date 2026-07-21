import Workspace from "@/components/Workspace";

// 嵌入模式：ezPLM 通过 /embed?embed=1&ezplm_project_id=xx&tier=paid 以 iframe 加载
export default function EmbedPage() {
  return <Workspace embed={true} />;
}
