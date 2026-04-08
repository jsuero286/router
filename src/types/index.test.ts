import { ChatMessage, ChatRequest, ConversationContext, OllamaResponse, NodeEntry, NodeType, NodeConfig, SelectedNode, OllamaPsModel, OllamaPsResponse, SkillFrontmatter, SkillEntry, Complexity } from "./index";

describe("ChatMessage", () => {
  it("should have the correct properties", () => {
    const message: ChatMessage = {
      role: "user",
      content: "Hello world"
    };

    expect(message).toEqual({ role: "user", content: "Hello world" });
  });
});

describe("ChatRequest", () => {
  it("should have the correct properties", () => {
    const request: ChatRequest = {
      model: "test_model",
      messages: [{ role: "user", content: "Hello" }],
      stream: true,
      user: "test_user"
    };

    expect(request).toEqual({
      model: "test_model",
      messages: [{ role: "user", content: "Hello" }],
      stream: true,
      user: "test_user"
    });
  });
});

describe("ConversationContext", () => {
  it("should have the correct properties", () => {
    const context: ConversationContext = {
      messages: [{ role: "user", content: "Hello" }],
      model: "test_model",
      skill: null,
      totalCostUsd: 0.5,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      turns: 1
    };

    expect(context).toEqual({
      messages: [{ role: "user", content: "Hello" }],
      model: "test_model",
      skill: null,
      totalCostUsd: 0.5,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      turns: 1
    });
  });
});

describe("OllamaResponse", () => {
  it("should have the correct properties", () => {
    const response: OllamaResponse = {
      message: { content: "Hello world" },
      done: true,
      prompt_eval_count: 1,
      eval_count: 1
    };

    expect(response).toEqual({
      message: { content: "Hello world" },
      done: true,
      prompt_eval_count: 1,
      eval_count: 1
    });
  });
});

describe("NodeEntry", () => {
  it("should have the correct properties", () => {
    const nodeEntry: NodeEntry = {
      nodeName: "test_node",
      model: "test_model"
    };

    expect(nodeEntry).toEqual({ nodeName: "test_node", model: "test_model" });
  });
});

describe("NodeType", () => {
  it("should be a string literal type", () => {
    expect(typeof NodeType).toBe("object");
    expect(NodeType.ollama).toBe("ollama");
    expect(NodeType.anthropic).toBe("anthropic");
    expect(NodeType.google).toBe("google");
  });
});

describe("NodeConfig", () => {
  it("should have the correct properties", () => {
    const nodeConfig: NodeConfig = {
      url: "https://api.example.com",
      apiKey: "test_key"
    };

    expect(nodeConfig).toEqual({ url: "https://api.example.com", apiKey: "test_key" });
  });
});

describe("SelectedNode", () => {
  it("should have the correct properties", () => {
    const selectedNode: SelectedNode = {
      nodeEntry: { nodeName: "test_node", model: "test_model" },
      config: { url: "https://api.example.com", apiKey: "test_key" }
    };

    expect(selectedNode).toEqual({
      nodeEntry: { nodeName: "test_node", model: "test_model" },
      config: { url: "https://api.example.com", apiKey: "test_key" }
    });
  });
});

describe("OllamaPsModel", () => {
  it("should have the correct properties", () => {
    const ollamaPsModel: OllamaPsModel = {
      id: "model_id",
      name: "test_model",
      description: "Test model for testing"
    };

    expect(ollamaPsModel).toEqual({
      id: "model_id",
      name: "test_model",
      description: "Test model for testing"
    });
  });
});

describe("OllamaPsResponse", () => {
  it("should have the correct properties", () => {
    const ollamaPsResponse: OllamaPsResponse = {
      models: [{ id: "model_id", name: "test_model", description: "Test model for testing" }]
    };

    expect(ollamaPsResponse).toEqual({
      models: [{ id: "model_id", name: "test_model", description: "Test model for testing" }]
    });
  });
});

describe("SkillFrontmatter", () => {
  it("should have the correct properties", () => {
    const skillFrontmatter: SkillFrontmatter = {
      title: "Test Skill",
      description: "This is a test skill"
    };

    expect(skillFrontmatter).toEqual({ title: "Test Skill", description: "This is a test skill" });
  });
});

describe("SkillEntry", () => {
  it("should have the correct properties", () => {
    const skillEntry: SkillEntry = {
      id: "skill_id",
      frontmatter: { title: "Test Skill", description: "This is a test skill" },
      content: "Test skill content"
    };

    expect(skillEntry).toEqual({
      id: "skill_id",
      frontmatter: { title: "Test Skill", description: "This is a test skill" },
      content: "Test skill content"
    });
  });
});

describe("Complexity", () => {
  it("should be a string literal type", () => {
    expect(typeof Complexity).toBe("object");
    expect(Complexity.easy).toBe("easy");
    expect(Complexity.medium).toBe("medium");
    expect(Complexity.difficult).toBe("difficult");
  });
});
