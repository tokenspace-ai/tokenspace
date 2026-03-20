import { useEffect, useState } from "react";

export function useModifierKey() {
  const [key, setKey] = useState("⌘");
  useEffect(() => {
    if (typeof navigator !== "undefined" && !navigator.userAgent.includes("Mac")) {
      setKey("Ctrl+");
    }
  }, []);
  return key;
}
