data "aws_caller_identity" "current" {}

resource "aws_kms_key" "application" {
  description             = "Amrutam application, database, cache, and runtime-secret encryption."
  enable_key_rotation     = true
  deletion_window_in_days = 30
  tags                    = { Name = "${var.name_prefix}-application" }
}

resource "aws_kms_alias" "application" {
  name          = "alias/${var.name_prefix}-application"
  target_key_id = aws_kms_key.application.key_id
}

resource "aws_kms_key" "audit" {
  description             = "Amrutam audit archive encryption."
  enable_key_rotation     = true
  deletion_window_in_days = 30
  tags                    = { Name = "${var.name_prefix}-audit" }
}

resource "aws_kms_alias" "audit" {
  name          = "alias/${var.name_prefix}-audit"
  target_key_id = aws_kms_key.audit.key_id
}

resource "aws_kms_key" "audit_replica" {
  provider                = aws.replica
  description             = "Amrutam audit archive replica encryption."
  enable_key_rotation     = true
  deletion_window_in_days = 30
  tags                    = { Name = "${var.name_prefix}-audit-replica" }
}

resource "aws_kms_alias" "audit_replica" {
  provider      = aws.replica
  name          = "alias/${var.name_prefix}-audit"
  target_key_id = aws_kms_key.audit_replica.key_id
}

resource "aws_ecr_repository" "application" {
  name                 = "${var.name_prefix}/telemedicine-backend"
  image_tag_mutability = "IMMUTABLE"
  force_delete         = false
  image_scanning_configuration {
    scan_on_push = true
  }
  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = aws_kms_key.application.arn
  }
  tags = { Name = "${var.name_prefix}-application" }
}

resource "aws_ecr_lifecycle_policy" "application" {
  repository = aws_ecr_repository.application.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Retain the newest 20 tagged images."
      selection = {
        tagStatus     = "tagged"
        tagPatternList = ["*"]
        countType     = "imageCountMoreThan"
        countNumber   = 20
      }
      action = { type = "expire" }
    }]
  })
}

resource "aws_secretsmanager_secret" "runtime" {
  name                    = "${var.name_prefix}/runtime"
  description             = "Amrutam application environment values."
  kms_key_id              = aws_kms_key.application.arn
  recovery_window_in_days = 30
  tags                    = { Name = "${var.name_prefix}-runtime" }
}

resource "aws_secretsmanager_secret_version" "runtime" {
  secret_id = aws_secretsmanager_secret.runtime.id
  secret_string = jsonencode({
    DATABASE_URL           = "postgresql://${urlencode(var.db_username)}:${urlencode(var.db_password)}@${aws_db_instance.primary.address}:${aws_db_instance.primary.port}/${var.db_name}?sslmode=verify-full"
    DATABASE_READ_URL      = "postgresql://${urlencode(var.db_username)}:${urlencode(var.db_password)}@${aws_db_instance.reader.address}:${aws_db_instance.reader.port}/${var.db_name}?sslmode=verify-full"
    REDIS_URL              = "rediss://:${urlencode(var.redis_auth_token)}@${aws_elasticache_replication_group.redis.primary_endpoint_address}:6379"
    JWT_KEYS               = var.runtime_secrets.jwt_keys_json
    JWT_ACTIVE_KID         = var.runtime_secrets.jwt_active_kid
    ENC_KEYS               = var.runtime_secrets.enc_keys_json
    ENC_ACTIVE_VERSION     = "1"
    KMS_KEY_ID             = aws_kms_key.application.arn
    PAYMENT_WEBHOOK_SECRET = var.runtime_secrets.payment_webhook_secret
    PAYMENT_API_KEY        = var.runtime_secrets.payment_api_key
    METRICS_TOKEN          = var.runtime_secrets.metrics_token
  })
}

resource "aws_iam_role" "github_deploy" {
  name               = "${var.name_prefix}-github-deploy"
  assume_role_policy = data.aws_iam_policy_document.github_assume_role.json
  tags               = { Name = "${var.name_prefix}-github-deploy" }
}

data "aws_iam_policy_document" "github_assume_role" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [local.github_oidc_provider_arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repository}:ref:refs/heads/${var.github_deploy_branch}"]
    }
  }
}

resource "aws_iam_policy" "github_deploy" {
  name        = "${var.name_prefix}-github-deploy"
  description = "Push the application image and deploy the ECS services from the protected GitHub branch."
  policy      = data.aws_iam_policy_document.github_deploy.json
}

data "aws_iam_policy_document" "github_deploy" {
  statement {
    sid       = "EcrAuthorization"
    effect    = "Allow"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid    = "PushApplicationImage"
    effect = "Allow"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:CompleteLayerUpload",
      "ecr:InitiateLayerUpload",
      "ecr:PutImage",
      "ecr:UploadLayerPart",
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer",
    ]
    resources = [aws_ecr_repository.application.arn]
  }

  statement {
    sid    = "DescribeEcsResources"
    effect = "Allow"
    actions = [
      "ecs:DescribeClusters",
      "ecs:DescribeServices",
      "ecs:DescribeTaskDefinition",
      "ecs:ListTasks",
      "ecs:RegisterTaskDefinition",
    ]
    resources = ["*"]
  }

  statement {
    sid       = "UpdateOnlyAmrutamServices"
    effect    = "Allow"
    actions   = ["ecs:UpdateService"]
    resources = [aws_ecs_service.api.arn, aws_ecs_service.worker.arn]
  }

  statement {
    sid       = "PassTaskRoles"
    effect    = "Allow"
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.ecs_execution.arn, aws_iam_role.ecs_task.arn]
    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy_attachment" "github_deploy" {
  role       = aws_iam_role.github_deploy.name
  policy_arn = aws_iam_policy.github_deploy.arn
}

resource "aws_iam_openid_connect_provider" "github" {
  count           = var.create_github_oidc_provider ? 1 : 0
  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = [var.github_oidc_thumbprint]
  tags            = { Name = "${var.name_prefix}-github-actions" }
}

locals {
  github_oidc_provider_arn = var.create_github_oidc_provider ? aws_iam_openid_connect_provider.github[0].arn : var.github_oidc_provider_arn
}
