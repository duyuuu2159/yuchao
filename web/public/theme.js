// 在页面画出来之前就定好明暗模式，避免先亮后暗地闪一下。
// 单独成文件而不是写在 index.html 里：内容安全策略（CSP）禁止所有内联脚本。
(() => {
  const saved = localStorage.getItem('yuchao-theme');
  const dark = saved === 'dark' || (saved !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
})();
