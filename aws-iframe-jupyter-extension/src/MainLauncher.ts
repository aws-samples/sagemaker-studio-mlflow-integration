import { Widget as PhosphorWidget } from "@phosphor/widgets";
import { Widget as LuminoWidget } from "@lumino/widgets";
export class PhosphorMainLauncher extends PhosphorWidget {
  /**
   * The image element associated with the widget.
   */
  consoleRoot: HTMLElement;
  /**
   * A path to css assets
   */
  cssPath: string;
}

export class LuminoMainLauncher extends LuminoWidget {
  /**
   * The image element associated with the widget.
   */
  consoleRoot: HTMLElement;
  /**
   * A path to css assets
   */
  cssPath: string;
}

export class MainLauncher {
  static create(): LuminoMainLauncher {
    const widget = new LuminoMainLauncher();

    widget.id = "aws_iframe_jupyter";
    widget.title.label = "MLFlow";
    widget.title.closable = true;

    widget.consoleRoot = document.createElement("div");
    widget.consoleRoot.setAttribute("style", "height: 100%");
    widget.node.appendChild(widget.consoleRoot);

    return widget;
  }
}
