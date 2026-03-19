export const schema = `
  type Claim {
    id: String!
    text: String!
    type: String!
    importance: Int!
  }

  type VerificationResult {
    claimId: String!
    status: String!
    explanation: String!
  }

  type ComplianceReport {
    riskTier: String!
  }

  type ScanResult {
    id: String!
    input: String!
    provider: String!
    claims: [Claim!]!
    overallRisk: String!
    complianceReport: ComplianceReport!
    scannedAt: String!
  }

  type Key {
    id: String!
    name: String!
    permissions: [String!]!
    createdAt: String!
  }

  type UsageDay {
    date: String!
    count: Int!
  }

  type AuditEntry {
    timestamp: String!
    keyId: String!
    endpoint: String!
    method: String!
    statusCode: Int!
    latencyMs: Int!
  }

  type Query {
    scan(text: String!, provider: String): ScanResult
    scans(keyId: String, limit: Int): [ScanResult!]!
    keys: [Key!]!
    usage(keyId: String!): [UsageDay!]!
    audit(limit: Int): [AuditEntry!]!
  }

  type Mutation {
    createKey(name: String!, permissions: [String!]): Key!
    deleteKey(id: String!): Boolean!
    scanBatch(texts: [String!]!, provider: String): [ScanResult!]!
  }
`;
