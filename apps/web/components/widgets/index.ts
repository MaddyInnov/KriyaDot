// SPDX-License-Identifier: Apache-2.0
// Public entry point for the in-chat widget framework.

export { WIDGET_KINDS, validateWidget, formatBytes, cellText } from './schema';
export type {
  Widget,
  WidgetKind,
  TableWidget,
  ChartWidget,
  ChartDataset,
  ActionsWidget,
  WidgetAction,
  MapWidget,
  FileWidget,
  WidgetOption,
  ButtonsWidget,
  SelectWidget,
  InputWidget,
  ConfirmWidget,
  ProgressWidget,
  ImageViewWidget,
  McpAppWidget,
  PageWidget,
  WidgetAnswerState,
  WidgetValidation,
} from './schema';
export {
  WIDGET_REGISTRY,
  registeredWidgetKinds,
  WidgetRenderer,
} from './widgets';
export type { WidgetActionHandler, WidgetAnswerHandler, WidgetRuntimeProps } from './widgets';
