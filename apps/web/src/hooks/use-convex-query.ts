import { useQueries } from "convex/react";
import { makeUseQueryWithStatus } from "convex-helpers/react";

export const useConvexQuery = makeUseQueryWithStatus(useQueries);
