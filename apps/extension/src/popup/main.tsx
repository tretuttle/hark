import { useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { activeTab, hark, openHistory, openSettings } from "../client.ts";
import { Popup } from "./Popup.tsx";
import { createPopupStore } from "./store.ts";
import "../styles.css";
import "../ui/controls.css";
import "./popup.css";

const store = createPopupStore({
  api: hark(),
  tab: activeTab,
  settings: openSettings,
  history: openHistory,
  pollMs: 250,
});

const Root = () => {
  const view = useSyncExternalStore(store.subscribe, store.view);
  return view === null ? null : <Popup view={view} dispatch={store.dispatch} />;
};

createRoot(document.getElementById("root")!).render(<Root />);
