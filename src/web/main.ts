import { createApp } from "vue";
import App from "./App.vue";
import { applyTheme } from "./theme.ts";
import "./style.css";
applyTheme();
createApp(App).mount("#app");
