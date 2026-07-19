import { render } from "preact";
import { App } from "./App.tsx";
import "./styles.css";

const root = document.getElementById("app");
if (root) {
  render(<App />, root);
}
