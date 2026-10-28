resource "aws_db_subnet_group" "main" {
  name       = "${var.name_prefix}-database"
  subnet_ids = aws_subnet.private[*].id
  tags       = { Name = "${var.name_prefix}-database" }
}

resource "aws_db_parameter_group" "postgres" {
  name        = "${var.name_prefix}-postgres16"
  family      = "postgres16"
  description = "PostgreSQL 16 with TLS required."
  parameter {
    name         = "rds.force_ssl"
    value        = "1"
    apply_method = "pending-reboot"
  }
  tags = { Name = "${var.name_prefix}-postgres16" }
}

resource "aws_db_instance" "primary" {
  identifier                          = "${var.name_prefix}-postgres"
  engine                              = "postgres"
  engine_version                      = var.db_engine_version
  instance_class                      = var.db_instance_class
  allocated_storage                   = var.db_allocated_storage_gib
  max_allocated_storage               = 500
  storage_type                        = "gp3"
  storage_encrypted                   = true
  kms_key_id                          = aws_kms_key.application.arn
  db_name                             = var.db_name
  username                            = var.db_username
  password                            = var.db_password
  port                                = 5432
  db_subnet_group_name                = aws_db_subnet_group.main.name
  parameter_group_name                = aws_db_parameter_group.postgres.name
  vpc_security_group_ids              = [aws_security_group.database.id]
  multi_az                            = true
  publicly_accessible                 = false
  backup_retention_period             = 35
  backup_window                       = "03:00-04:00"
  maintenance_window                  = "sun:04:00-sun:05:00"
  enabled_cloudwatch_logs_exports     = ["postgresql"]
  auto_minor_version_upgrade          = true
  allow_major_version_upgrade         = false
  deletion_protection                 = true
  copy_tags_to_snapshot               = true
  skip_final_snapshot                 = false
  final_snapshot_identifier           = "${var.name_prefix}-postgres-final-${data.aws_caller_identity.current.account_id}"
  delete_automated_backups             = false
  performance_insights_enabled        = true
  performance_insights_kms_key_id     = aws_kms_key.application.arn
  performance_insights_retention_period = 7
  tags                                 = { Name = "${var.name_prefix}-postgres-primary" }

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_db_instance" "reader" {
  identifier                          = "${var.name_prefix}-postgres-reader"
  replicate_source_db                 = aws_db_instance.primary.identifier
  instance_class                      = var.db_instance_class
  publicly_accessible                 = false
  auto_minor_version_upgrade          = true
  deletion_protection                 = true
  performance_insights_enabled        = true
  performance_insights_kms_key_id     = aws_kms_key.application.arn
  performance_insights_retention_period = 7
  tags                                 = { Name = "${var.name_prefix}-postgres-reader" }

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_elasticache_subnet_group" "main" {
  name       = "${var.name_prefix}-redis"
  subnet_ids = aws_subnet.private[*].id
  tags       = { Name = "${var.name_prefix}-redis" }
}

resource "aws_elasticache_replication_group" "redis" {
  replication_group_id       = "${var.name_prefix}-redis"
  description                = "Multi-AZ Redis 7 queue and cache cluster."
  engine                     = "redis"
  engine_version             = "7.0"
  node_type                  = var.redis_node_type
  port                       = 6379
  num_cache_clusters         = 2
  automatic_failover_enabled = true
  multi_az_enabled           = true
  subnet_group_name          = aws_elasticache_subnet_group.main.name
  security_group_ids         = [aws_security_group.redis.id]
  parameter_group_name       = "default.redis7"
  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  auth_token                 = var.redis_auth_token
  kms_key_id                 = aws_kms_key.application.arn
  snapshot_retention_limit   = 7
  snapshot_window            = "05:00-06:00"
  maintenance_window         = "sun:06:00-sun:07:00"
  apply_immediately          = false
  tags                       = { Name = "${var.name_prefix}-redis" }
}
