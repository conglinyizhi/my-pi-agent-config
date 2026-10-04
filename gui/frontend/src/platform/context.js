import { inject } from "vue";

/** Vue 注入键：页面与组件只能通过此接口使用宿主能力，不能直接访问 window.go。 */
export const platformKey = Symbol("pi-gui-platform");

export function usePlatform() {
  const platform = inject(platformKey);
  if (!platform) throw new Error("GUI platform adapter is unavailable");
  return platform;
}
