import type { ReactElement } from "react";

export interface PreviewableEmail<Props> {
  (props: Props): ReactElement;
  PreviewProps?: Props;
}
