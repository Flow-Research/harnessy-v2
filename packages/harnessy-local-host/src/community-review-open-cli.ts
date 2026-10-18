#!/usr/bin/env node

import { communityReviewOpenProfile, runReviewOpen } from "./review-open.ts";

await runReviewOpen(communityReviewOpenProfile, process.argv.slice(2));
