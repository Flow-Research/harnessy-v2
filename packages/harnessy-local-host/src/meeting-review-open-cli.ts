#!/usr/bin/env node

import { meetingReviewOpenProfile, runReviewOpen } from "./review-open.ts";

await runReviewOpen(meetingReviewOpenProfile, process.argv.slice(2));
