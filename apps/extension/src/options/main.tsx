import { useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { hark } from "../client.ts";
import { ApiMissing } from "../ui/page.tsx";
import { Options, OPTIONS_TITLE } from "./Options.tsx";
import { createOptionsStore, type OptionsStore } from "./store.ts";
import "../styles.css";
import "../ui/controls.css";
import "../ui/page.css";
import "./options.css";

const Root = ({ store }: { readonly store: OptionsStore }) => {
  const state = useSyncExternalStore(store.subscribe, store.state);
  return <Options state={state} store={store} />;
};

const api = hark();
createRoot(document.getElementById("root")!).render(
  api === null ? <ApiMissing title={OPTIONS_TITLE} /> : <Root store={createOptionsStore(api)} />,
);
