/// <reference types="vite/client" />

// Vite 的 CSS 导入在 TS 里需要类型声明，否则 `import "./styles.css"` 会报找不到模块。
declare module "*.css" {
  const content: string;
  export default content;
}
