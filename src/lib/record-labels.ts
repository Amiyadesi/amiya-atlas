export const RECORD_GROUPS = [
  { label: "账号", types: ["Account", "Identity", "Website Account", "AI Provider Account"] },
  { label: "通信", types: ["Email", "Phone / SIM", "SIM"] },
  { label: "资金", types: ["Bank Account", "Payment Card"] },
  { label: "服务", types: ["Subscription", "Service", "Provider"] },
  { label: "设施", types: ["Domain", "Server"] },
  { label: "项目", types: ["Project", "Repository", "Client", "Order"] },
  { label: "其他", types: ["Generic"] },
];
export const RECORD_TYPES = ["Account", "Email", "Phone / SIM", "Payment Card", "Bank Account", "Subscription", "Service", "Provider", "Domain", "Server", "Project", "Repository", "Client", "Order", "Generic"];
const categories: Record<string, string> = {
  Client: "客户", Order: "订单",
  Account: "账号", Identity: "登录身份", "Website Account": "网站账号", "AI Provider Account": "AI 账号",
  Email: "邮箱", "Phone / SIM": "号码", SIM: "号码", "Bank Account": "银行账户", "Payment Card": "银行卡",
  Subscription: "订阅", Service: "服务", Provider: "平台 / 服务商", Domain: "域名", Server: "服务器", Project: "项目", Repository: "代码库", Generic: "其他",
};
export const categoryLabel = (value: string) => categories[value] ?? value;
export const categoryGroup = (value: string) => RECORD_GROUPS.find(group => group.types.includes(value))?.label ?? "其他";
export const statusLabel = (value: string) => ({ ACTIVE: "在用", NEEDS_REVIEW: "待整理", PLANNED: "计划中", ARCHIVED: "已归档", INACTIVE: "停用" }[value] ?? value);
export const eventLabel = (value: string) => ({ EXPIRY: "到期", RENEWAL: "续费", REVIEW: "检查", PAYMENT_DUE: "付款", CANCELLATION: "取消", REMINDER: "提醒", CUSTOM: "自定义" }[value] ?? value);
export const relationLabel = (value: string) => ({
  INVOICED_TO: "客户", ALLOCATED_TO: "分摊",
  REGISTERED_WITH: "注册方式", AUTHENTICATES_WITH: "登录身份", RECOVERS_WITH: "找回方式", OWNS_ADDRESS: "拥有地址",
  MANAGES: "管理", USES: "使用", DEPENDS_ON: "依赖", HOSTS: "托管", HOSTED_ON: "托管于", CONNECTED_VIA: "连接方式",
  EXPOSED_AT: "访问地址", SOURCE_IN: "源码位于", DEPLOYED_ON: "部署于", PAID_BY: "付款方式", BILLED_FOR: "支付对象",
  ISSUED_BY: "提供方", STORED_IN: "保存于", RELATED_TO: "相关", OWNS: "拥有", MANAGED_BY: "由其管理",
}[value] ?? value);
export const TAG_SUGGESTIONS = ["收藏", "主用", "备用", "工作", "个人", "待处理"];
