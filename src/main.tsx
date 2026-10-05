import { render } from "preact";
import { applyHostTheme } from "./sdk";
import { App } from "./ui/App";
import "./styles.css";

applyHostTheme();
render(<App />, document.getElementById("app")!);
