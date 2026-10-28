resource "aws_cloudwatch_log_group" "api" {
  name              = "/amrutam/${var.environment}/api"
  retention_in_days = 90
  kms_key_id        = aws_kms_key.application.arn
  tags              = { Name = "${var.name_prefix}-api-logs" }
}

resource "aws_cloudwatch_log_group" "worker" {
  name              = "/amrutam/${var.environment}/worker"
  retention_in_days = 90
  kms_key_id        = aws_kms_key.application.arn
  tags              = { Name = "${var.name_prefix}-worker-logs" }
}

resource "aws_ecs_cluster" "main" {
  name = "${var.name_prefix}-cluster"
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
  tags = { Name = "${var.name_prefix}-cluster" }
}

data "aws_iam_policy_document" "ecs_tasks_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "ecs_execution" {
  name               = "${var.name_prefix}-ecs-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume_role.json
  tags               = { Name = "${var.name_prefix}-ecs-execution" }
}

resource "aws_iam_role_policy_attachment" "ecs_execution_managed" {
  role       = aws_iam_role.ecs_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "ecs_execution_secrets" {
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.runtime.arn]
  }
  statement {
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.application.arn]
  }
}

resource "aws_iam_role_policy" "ecs_execution_secrets" {
  name   = "${var.name_prefix}-ecs-secrets"
  role   = aws_iam_role.ecs_execution.id
  policy = data.aws_iam_policy_document.ecs_execution_secrets.json
}

resource "aws_iam_role" "ecs_task" {
  name               = "${var.name_prefix}-ecs-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume_role.json
  tags               = { Name = "${var.name_prefix}-ecs-task" }
}

data "aws_iam_policy_document" "ecs_task_kms" {
  statement {
    actions = [
      "kms:Decrypt",
      "kms:GenerateDataKey",
    ]
    resources = [aws_kms_key.application.arn]
  }
}

resource "aws_iam_role_policy" "ecs_task_kms" {
  name   = "${var.name_prefix}-ecs-kms"
  role   = aws_iam_role.ecs_task.id
  policy = data.aws_iam_policy_document.ecs_task_kms.json
}

locals {
  common_environment = [
    { name = "NODE_ENV", value = "production" },
    { name = "PORT", value = "3000" },
    { name = "LOG_LEVEL", value = "info" },
    { name = "CORS_ORIGINS", value = var.cors_origins },
    { name = "TRUST_PROXY", value = "1" },
    { name = "DB_POOL_MAX", value = "15" },
    { name = "DB_STATEMENT_TIMEOUT_MS", value = "5000" },
    { name = "DB_IDLE_IN_TX_TIMEOUT_MS", value = "10000" },
    { name = "JWT_ACCESS_TTL_SEC", value = "900" },
    { name = "REFRESH_TTL_DAYS", value = "14" },
    { name = "MFA_TOKEN_TTL_SEC", value = "300" },
    { name = "MFA_ISSUER", value = "Amrutam" },
    { name = "LOGIN_MAX_FAILURES", value = "5" },
    { name = "LOGIN_LOCK_MINUTES", value = "15" },
    { name = "RL_GLOBAL_PER_MIN", value = "120" },
    { name = "RL_AUTH_PER_MIN", value = "10" },
    { name = "RL_BOOKING_PER_MIN", value = "20" },
    { name = "SLOT_HOLD_MINUTES", value = "10" },
    { name = "MIN_BOOKING_LEAD_MINUTES", value = "15" },
    { name = "CANCEL_FULL_REFUND_HOURS", value = "24" },
    { name = "IDEMPOTENCY_TTL_HOURS", value = "24" },
    { name = "PAYMENT_PROVIDER", value = var.payment_provider },
    { name = "PAYMENT_TIMEOUT_MS", value = "3000" },
    { name = "OTEL_EXPORTER_OTLP_ENDPOINT", value = var.otel_exporter_otlp_endpoint },
  ]

  common_secrets = [
    { name = "DATABASE_URL", valueFrom = "${aws_secretsmanager_secret.runtime.arn}:DATABASE_URL::" },
    { name = "DATABASE_READ_URL", valueFrom = "${aws_secretsmanager_secret.runtime.arn}:DATABASE_READ_URL::" },
    { name = "REDIS_URL", valueFrom = "${aws_secretsmanager_secret.runtime.arn}:REDIS_URL::" },
    { name = "JWT_KEYS", valueFrom = "${aws_secretsmanager_secret.runtime.arn}:JWT_KEYS::" },
    { name = "JWT_ACTIVE_KID", valueFrom = "${aws_secretsmanager_secret.runtime.arn}:JWT_ACTIVE_KID::" },
    { name = "ENC_KEYS", valueFrom = "${aws_secretsmanager_secret.runtime.arn}:ENC_KEYS::" },
    { name = "ENC_ACTIVE_VERSION", valueFrom = "${aws_secretsmanager_secret.runtime.arn}:ENC_ACTIVE_VERSION::" },
    { name = "KMS_KEY_ID", valueFrom = "${aws_secretsmanager_secret.runtime.arn}:KMS_KEY_ID::" },
    { name = "PAYMENT_WEBHOOK_SECRET", valueFrom = "${aws_secretsmanager_secret.runtime.arn}:PAYMENT_WEBHOOK_SECRET::" },
    { name = "PAYMENT_API_KEY", valueFrom = "${aws_secretsmanager_secret.runtime.arn}:PAYMENT_API_KEY::" },
    { name = "METRICS_TOKEN", valueFrom = "${aws_secretsmanager_secret.runtime.arn}:METRICS_TOKEN::" },
  ]

  image = "${aws_ecr_repository.application.repository_url}:${var.image_tag}"
}

resource "aws_ecs_task_definition" "api" {
  family                   = "${var.name_prefix}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "512"
  memory                   = "1024"
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn
  container_definitions = jsonencode([{
    name      = "api"
    image     = local.image
    essential = true
    user      = "1000"
    command   = ["node", "dist/src/server.js"]
    environment = concat(local.common_environment, [
      { name = "OTEL_SERVICE_NAME", value = "amrutam-api" },
    ])
    secrets = local.common_secrets
    portMappings = [
      { containerPort = 3000, hostPort = 3000, protocol = "tcp" },
    ]
    healthCheck = {
      command     = ["CMD-SHELL", "node -e \"fetch('http://127.0.0.1:3000/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 60
    }
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.api.name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "api"
      }
    }
  }])
  depends_on = [aws_secretsmanager_secret_version.runtime]
  tags = { Name = "${var.name_prefix}-api-task" }
}

resource "aws_ecs_task_definition" "worker" {
  family                   = "${var.name_prefix}-worker"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "1024"
  memory                   = "2048"
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn
  container_definitions = jsonencode([{
    name      = "worker"
    image     = local.image
    essential = true
    user      = "1000"
    command   = ["node", "dist/src/worker.js"]
    stopTimeout = 120
    environment = concat(local.common_environment, [
      { name = "OTEL_SERVICE_NAME", value = "amrutam-worker" },
    ])
    secrets = local.common_secrets
    portMappings = [
      { containerPort = 9464, hostPort = 9464, protocol = "tcp" },
    ]
    healthCheck = {
      command     = ["CMD-SHELL", "node -e \"process.kill(1,0)\""]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 60
    }
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.worker.name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "worker"
      }
    }
  }])
  depends_on = [aws_secretsmanager_secret_version.runtime]
  tags = { Name = "${var.name_prefix}-worker-task" }
}

resource "aws_lb" "api" {
  name                       = substr("${var.name_prefix}-api", 0, 32)
  internal                   = false
  load_balancer_type         = "application"
  security_groups            = [aws_security_group.alb.id]
  subnets                    = aws_subnet.public[*].id
  enable_deletion_protection = true
  drop_invalid_header_fields = true
  tags                       = { Name = "${var.name_prefix}-api" }
}

resource "aws_lb_target_group" "api" {
  name                 = substr("${var.name_prefix}-api", 0, 32)
  port                 = 3000
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = aws_vpc.main.id
  deregistration_delay = 30
  health_check {
    enabled             = true
    path                = "/health/ready"
    protocol            = "HTTP"
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
  tags = { Name = "${var.name_prefix}-api" }
}

resource "aws_lb_listener" "api_https" {
  load_balancer_arn = aws_lb.api.arn
  port              = 443
  protocol          = "HTTPS"
  certificate_arn   = var.certificate_arn
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
}

resource "aws_wafv2_web_acl" "api" {
  name        = "${var.name_prefix}-api"
  description = "Managed OWASP protections and request rate limits for the API."
  scope       = "REGIONAL"
  default_action {
    allow {}
  }
  rule {
    name     = "AWSManagedCommonRuleSet"
    priority = 10
    override_action {
      none {}
    }
    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesCommonRuleSet"
        vendor_name = "AWS"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.name_prefix}-common-rules"
      sampled_requests_enabled   = true
    }
  }
  rule {
    name     = "RateLimitPerIp"
    priority = 20
    action {
      block {}
    }
    statement {
      rate_based_statement {
        limit              = 2000
        aggregate_key_type = "IP"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.name_prefix}-rate-limit"
      sampled_requests_enabled   = true
    }
  }
  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${var.name_prefix}-api-waf"
    sampled_requests_enabled   = true
  }
  tags = { Name = "${var.name_prefix}-api-waf" }
}

resource "aws_wafv2_web_acl_association" "api" {
  resource_arn = aws_lb.api.arn
  web_acl_arn  = aws_wafv2_web_acl.api.arn
}

resource "aws_ecs_service" "api" {
  name                               = "${var.name_prefix}-api"
  cluster                            = aws_ecs_cluster.main.id
  task_definition                    = aws_ecs_task_definition.api.arn
  desired_count                      = var.api_desired_count
  launch_type                        = "FARGATE"
  platform_version                   = "LATEST"
  health_check_grace_period_seconds  = 90
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  enable_execute_command             = false
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.application.id]
    assign_public_ip = false
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "api"
    container_port   = 3000
  }
  depends_on = [aws_lb_listener.api_https, aws_wafv2_web_acl_association.api]
  tags       = { Name = "${var.name_prefix}-api" }
}

resource "aws_ecs_service" "worker" {
  name                               = "${var.name_prefix}-worker"
  cluster                            = aws_ecs_cluster.main.id
  task_definition                    = aws_ecs_task_definition.worker.arn
  desired_count                      = var.worker_desired_count
  launch_type                        = "FARGATE"
  platform_version                   = "LATEST"
  deployment_minimum_healthy_percent = 50
  deployment_maximum_percent         = 200
  enable_execute_command             = false
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.application.id]
    assign_public_ip = false
  }
  tags = { Name = "${var.name_prefix}-worker" }
}

resource "aws_appautoscaling_target" "api" {
  max_capacity       = 20
  min_capacity       = 3
  resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.api.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

resource "aws_appautoscaling_policy" "api_cpu" {
  name               = "${var.name_prefix}-api-cpu"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.api.resource_id
  scalable_dimension = aws_appautoscaling_target.api.scalable_dimension
  service_namespace  = aws_appautoscaling_target.api.service_namespace
  target_tracking_scaling_policy_configuration {
    target_value       = 60
    scale_in_cooldown  = 300
    scale_out_cooldown = 60
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}

resource "aws_appautoscaling_policy" "api_requests" {
  name               = "${var.name_prefix}-api-requests"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.api.resource_id
  scalable_dimension = aws_appautoscaling_target.api.scalable_dimension
  service_namespace  = aws_appautoscaling_target.api.service_namespace
  target_tracking_scaling_policy_configuration {
    target_value       = 1800
    scale_in_cooldown  = 300
    scale_out_cooldown = 60
    predefined_metric_specification {
      predefined_metric_type = "ALBRequestCountPerTarget"
      resource_label         = "${aws_lb.api.arn_suffix}/${aws_lb_target_group.api.arn_suffix}"
    }
  }
}

resource "aws_appautoscaling_target" "worker" {
  max_capacity       = 20
  min_capacity       = 2
  resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.worker.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

resource "aws_appautoscaling_policy" "worker_cpu" {
  name               = "${var.name_prefix}-worker-cpu"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.worker.resource_id
  scalable_dimension = aws_appautoscaling_target.worker.scalable_dimension
  service_namespace  = aws_appautoscaling_target.worker.service_namespace
  target_tracking_scaling_policy_configuration {
    target_value       = 70
    scale_in_cooldown  = 300
    scale_out_cooldown = 60
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}
