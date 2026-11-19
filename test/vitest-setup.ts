// Runs before each test file: app.start approvals go to a per-process file, never the real ~/.config/notyours.
import os from 'node:os';
import path from 'node:path';
import { setApprovalsPathForTests } from '../src/hooks/app-approval.js';

setApprovalsPathForTests(path.join(os.tmpdir(), `notyours-test-approvals-${process.pid}.json`));
