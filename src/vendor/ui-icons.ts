// Lucide icons (ISC); upstream SVGs and license are vendored alongside this file.
import x from "./lucide/x.svg" with { type: "text" };
import zoomIn from "./lucide/zoom-in.svg" with { type: "text" };
import zoomOut from "./lucide/zoom-out.svg" with { type: "text" };
import scan from "./lucide/scan.svg" with { type: "text" };
import panelTopClose from "./lucide/panel-top-close.svg" with { type: "text" };
import panelTopOpen from "./lucide/panel-top-open.svg" with { type: "text" };
import panelRightClose from "./lucide/panel-right-close.svg" with { type: "text" };
import panelRightOpen from "./lucide/panel-right-open.svg" with { type: "text" };
import panelLeftClose from "./lucide/panel-left-close.svg" with { type: "text" };
import panelLeftOpen from "./lucide/panel-left-open.svg" with { type: "text" };
import listTree from "./lucide/list-tree.svg" with { type: "text" };
import listFilter from "./lucide/list-filter.svg" with { type: "text" };
import messagesSquare from "./lucide/messages-square.svg" with { type: "text" };
import chartNoAxesColumn from "./lucide/chart-no-axes-column.svg" with { type: "text" };
import layoutGrid from "./lucide/layout-grid.svg" with { type: "text" };
import ellipsis from "./lucide/ellipsis.svg" with { type: "text" };
import play from "./lucide/play.svg" with { type: "text" };
import pause from "./lucide/pause.svg" with { type: "text" };
import skipBack from "./lucide/skip-back.svg" with { type: "text" };
import skipForward from "./lucide/skip-forward.svg" with { type: "text" };
import maximize from "./lucide/maximize.svg" with { type: "text" };
import minimize from "./lucide/minimize.svg" with { type: "text" };
import arrowLeft from "./lucide/arrow-left.svg" with { type: "text" };
import arrowRight from "./lucide/arrow-right.svg" with { type: "text" };
import chevronsUp from "./lucide/chevrons-up.svg" with { type: "text" };
import chevronsDown from "./lucide/chevrons-down.svg" with { type: "text" };
import arrowUp from "./lucide/arrow-up.svg" with { type: "text" };
import arrowDown from "./lucide/arrow-down.svg" with { type: "text" };
import cornerLeftUp from "./lucide/corner-left-up.svg" with { type: "text" };
import cornerLeftDown from "./lucide/corner-left-down.svg" with { type: "text" };
import fileText from "./lucide/file-text.svg" with { type: "text" };
import gitBranch from "./lucide/git-branch.svg" with { type: "text" };
import copy from "./lucide/copy.svg" with { type: "text" };
import check from "./lucide/check.svg" with { type: "text" };
import sun from "./lucide/sun.svg" with { type: "text" };
import moon from "./lucide/moon.svg" with { type: "text" };
import monitor from "./lucide/monitor.svg" with { type: "text" };
import eye from "./lucide/eye.svg" with { type: "text" };
import eyeOff from "./lucide/eye-off.svg" with { type: "text" };
import search from "./lucide/search.svg" with { type: "text" };
import archive from "./lucide/archive.svg" with { type: "text" };
import refreshCw from "./lucide/refresh-cw.svg" with { type: "text" };
import chevronRight from "./lucide/chevron-right.svg" with { type: "text" };

export const UI_ICONS = Object.fromEntries(
  Object.entries({ x, zoomIn, zoomOut, scan, panelTopClose, panelTopOpen, panelRightClose, panelRightOpen, panelLeftClose, panelLeftOpen, listTree, listFilter, messagesSquare, chartNoAxesColumn, layoutGrid, ellipsis, play, pause, skipBack, skipForward, maximize, minimize, arrowLeft, arrowRight, chevronsUp, chevronsDown, arrowUp, arrowDown, cornerLeftUp, cornerLeftDown, fileText, gitBranch, copy, check, sun, moon, monitor, eye, eyeOff, search, archive, refreshCw, chevronRight }).map(([name, svg]) => [name, svg.replace('<svg', '<svg class="ui-icon" aria-hidden="true"')]),
);
