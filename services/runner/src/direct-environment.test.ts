// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:macos", "os:windows", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { directHostEnvironment } from "./direct-environment.js";

test("host execution retains Windows runtime variables without service or user secrets", () => {
  const env = directHostEnvironment({
    SystemRoot: "C:\\Windows", ComSpec: "C:\\Windows\\System32\\cmd.exe", TEMP: "C:\\Temp",
    SCIENCE_AGENT_RUNNER_TOKEN: "synthetic-runner-token", OPENAI_API_KEY: "synthetic-api-key",
    UNKNOWN_SECRET: "synthetic-secret", HTTP_PROXY: "http://user:password@proxy", PYTHONPATH: "untrusted",
    Path: "host-path", NODE_OPTIONS: "--require untrusted.js", LD_PRELOAD: "untrusted.so",
  });
  assert.deepEqual(env, { SystemRoot: "C:\\Windows", ComSpec: "C:\\Windows\\System32\\cmd.exe", TEMP: "C:\\Temp" });
});
