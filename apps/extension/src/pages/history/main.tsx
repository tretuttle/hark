import { useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { hark } from "../../client.ts";
import { ApiMissing } from "../../ui/page.tsx";
import { History, HISTORY_TITLE } from "./History.tsx";
import { createHistoryStore, type HistoryStore } from "./store.ts";
import "../../styles.css";
import "../../ui/controls.css";
import "../../ui/page.css";
import "./history.css";

const Root = ({ store }: { readonly store: HistoryStore }) => {
  const state = useSyncExternalStore(store.subscribe, store.state);
  return <History state={state} store={store} />;
};

const api = hark();
createRoot(document.getElementById("root")!).render(
  api === null ? (
    <ApiMissing title={HISTORY_TITLE} />
  ) : (
    <Root store={createHistoryStore(api, 250)} />
  ),
);
