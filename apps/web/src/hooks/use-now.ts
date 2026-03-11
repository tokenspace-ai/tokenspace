import { useEffect, useState } from "react";

const callbacks = new Set<() => void>();

setInterval(() => {
  if (callbacks.size > 0) {
    [...callbacks].forEach((cb) => {
      cb();
    });
  }
}, 15_000);

export function useNow() {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const callback = () => {
      setNow(Date.now());
    };
    callbacks.add(callback);
    return () => {
      callbacks.delete(callback);
    };
  }, []);

  return now;
}
