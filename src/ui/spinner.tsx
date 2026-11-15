import type React from "react";

import { LoaderCircle, type LoaderCircleProps } from "@/ui/icons";

export function Spinner({ className, ...props }: LoaderCircleProps): React.ReactElement {
  return <LoaderCircle animate aria-label="Loading" className={className} role="status" {...props} />;
}
