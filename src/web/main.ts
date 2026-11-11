import { createApp } from "vue";
import App from "./App.vue";
import { applyTheme } from "./theme.ts";
import { startMotionClock } from "./motion-clock.ts";
import "./style.css";
applyTheme();
const app = createApp(App);
app.mount("#app");
app.onUnmount(startMotionClock());
