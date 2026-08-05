import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { defaultNS, resources } from "./resources";

void i18n.use(initReactI18next).init({
  resources,
  lng: "zh-CN",
  fallbackLng: "zh-CN",
  defaultNS,
  initAsync: false,
  returnNull: false,
  interpolation: {
    escapeValue: false,
  },
});

export default i18n;
