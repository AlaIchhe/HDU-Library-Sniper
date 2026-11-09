import { IconLoader2 } from "@tabler/icons-react";
import type React from "react";
import { cn } from "@/lib/utils";

export function Spinner({
  className,
  ...props
}: React.ComponentProps<typeof IconLoader2>): React.ReactElement {
  return (
    <IconLoader2 aria-label="Loading" className={cn("animate-spin", className)} role="status" {...props} />
  );
}
