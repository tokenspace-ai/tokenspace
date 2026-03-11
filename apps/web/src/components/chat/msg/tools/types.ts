export type AgentTools = {
  runCode: {
    input: {
      description: string;
      code: string;
      timeoutMs: number;
    };
    output: {
      success: boolean;
      error?: string;
      jobId?: string;
    };
  };
  readFile: {
    input: {
      path: string;
    };
    output: {
      content: string;
    };
  };
  writeFile: {
    input: {
      path: string;
      content: string;
    };
    output: {
      success: boolean;
    };
  };
  bash: {
    input: {
      description: string;
      command: string;
      cwd: string;
      timeoutMs: number;
    };
    output: {
      success: boolean;
      error?: string;
      output?: string;
    };
  };
  requestApproval: {
    input: {
      action: string;
      data?: any;
      info?: any;
      description?: string;
      reason?: string;
    };
    output: {
      approved: boolean;
      comment?: string;
    };
  };
  subAgent: {
    input: {
      prompt: string;
      contextMode: "none" | "summary" | "full";
      threadId?: string;
      threadIds?: string[];
      waitForResult: boolean;
      profile: "default" | "web_search";
      storeTranscript: boolean;
    };
    output: {
      success: boolean;
      error?: string;
      threadId?: string;
    };
  };
};
