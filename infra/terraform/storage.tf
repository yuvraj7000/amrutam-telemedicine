resource "aws_s3_bucket" "audit" {
  bucket              = "${var.name_prefix}-audit-${data.aws_caller_identity.current.account_id}-${var.aws_region}"
  object_lock_enabled = true
  force_destroy       = false
  tags                = { Name = "${var.name_prefix}-audit-archive" }
  lifecycle {
    precondition {
      condition     = var.aws_region != var.failover_region
      error_message = "failover_region must differ from aws_region for cross-region backups."
    }
  }
}

resource "aws_s3_bucket_ownership_controls" "audit" {
  bucket = aws_s3_bucket.audit.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "audit" {
  bucket                  = aws_s3_bucket.audit.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "audit" {
  bucket = aws_s3_bucket.audit.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "audit" {
  bucket = aws_s3_bucket.audit.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.audit.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_object_lock_configuration" "audit" {
  bucket = aws_s3_bucket.audit.id
  rule {
    default_retention {
      mode = "COMPLIANCE"
      days = 2555
    }
  }
  depends_on = [aws_s3_bucket_versioning.audit]
}

resource "aws_s3_bucket" "audit_replica" {
  provider            = aws.replica
  bucket              = "${var.name_prefix}-audit-${data.aws_caller_identity.current.account_id}-${var.failover_region}"
  object_lock_enabled = true
  force_destroy       = false
  tags                = { Name = "${var.name_prefix}-audit-replica" }
}

resource "aws_s3_bucket_ownership_controls" "audit_replica" {
  provider = aws.replica
  bucket   = aws_s3_bucket.audit_replica.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "audit_replica" {
  provider                = aws.replica
  bucket                  = aws_s3_bucket.audit_replica.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "audit_replica" {
  provider = aws.replica
  bucket   = aws_s3_bucket.audit_replica.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "audit_replica" {
  provider = aws.replica
  bucket   = aws_s3_bucket.audit_replica.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.audit_replica.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket" "backups_replica" {
  provider     = aws.replica
  bucket       = "${var.name_prefix}-backups-${data.aws_caller_identity.current.account_id}-${var.failover_region}"
  force_destroy = false
  tags         = { Name = "${var.name_prefix}-backups-replica" }
}

resource "aws_s3_bucket_ownership_controls" "backups_replica" {
  provider = aws.replica
  bucket   = aws_s3_bucket.backups_replica.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "backups_replica" {
  provider                = aws.replica
  bucket                  = aws_s3_bucket.backups_replica.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "backups_replica" {
  provider = aws.replica
  bucket   = aws_s3_bucket.backups_replica.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "backups_replica" {
  provider = aws.replica
  bucket   = aws_s3_bucket.backups_replica.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.audit_replica.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "backups_replica" {
  provider = aws.replica
  bucket   = aws_s3_bucket.backups_replica.id
  rule {
    id     = "expire-old-replicated-backups"
    status = "Enabled"
    filter {}
    expiration {
      days = 365
    }
    noncurrent_version_expiration {
      noncurrent_days = 365
    }
  }
  depends_on = [aws_s3_bucket_versioning.backups_replica]
}

resource "aws_s3_bucket_object_lock_configuration" "audit_replica" {
  provider = aws.replica
  bucket   = aws_s3_bucket.audit_replica.id
  rule {
    default_retention {
      mode = "COMPLIANCE"
      days = 2555
    }
  }
  depends_on = [aws_s3_bucket_versioning.audit_replica]
}

resource "aws_iam_role" "s3_replication" {
  name               = "${var.name_prefix}-audit-replication"
  assume_role_policy = data.aws_iam_policy_document.s3_replication_assume_role.json
}

data "aws_iam_policy_document" "s3_replication_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["s3.amazonaws.com"]
    }
  }
}

resource "aws_iam_policy" "s3_replication" {
  name   = "${var.name_prefix}-audit-replication"
  policy = data.aws_iam_policy_document.s3_replication.json
}

data "aws_iam_policy_document" "s3_replication" {
  statement {
    actions   = ["s3:GetReplicationConfiguration", "s3:ListBucket"]
    resources = [aws_s3_bucket.audit.arn]
  }
  statement {
    actions = [
      "s3:GetObjectVersionForReplication",
      "s3:GetObjectVersionAcl",
      "s3:GetObjectVersionTagging",
    ]
    resources = ["${aws_s3_bucket.audit.arn}/*"]
  }
  statement {
    actions = [
      "s3:ReplicateObject",
      "s3:ReplicateDelete",
      "s3:ReplicateTags",
      "s3:ObjectOwnerOverrideToBucketOwner",
    ]
    resources = ["${aws_s3_bucket.audit_replica.arn}/*"]
  }
  statement {
    actions   = ["s3:GetReplicationConfiguration", "s3:ListBucket"]
    resources = [aws_s3_bucket.backups.arn]
  }
  statement {
    actions = [
      "s3:GetObjectVersionForReplication",
      "s3:GetObjectVersionAcl",
      "s3:GetObjectVersionTagging",
    ]
    resources = ["${aws_s3_bucket.backups.arn}/*"]
  }
  statement {
    actions = [
      "s3:ReplicateObject",
      "s3:ReplicateDelete",
      "s3:ReplicateTags",
    ]
    resources = ["${aws_s3_bucket.backups_replica.arn}/*"]
  }
  statement {
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.audit.arn]
  }
  statement {
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.application.arn]
  }
  statement {
    actions   = ["kms:Encrypt", "kms:GenerateDataKey"]
    resources = [aws_kms_key.audit_replica.arn]
  }
}

resource "aws_iam_role_policy_attachment" "s3_replication" {
  role       = aws_iam_role.s3_replication.name
  policy_arn = aws_iam_policy.s3_replication.arn
}

resource "aws_s3_bucket_replication_configuration" "audit" {
  bucket = aws_s3_bucket.audit.id
  role   = aws_iam_role.s3_replication.arn

  rule {
    id     = "cross-region-object-lock-archive"
    status = "Enabled"
    filter {}
    delete_marker_replication {
      status = "Disabled"
    }
    source_selection_criteria {
      sse_kms_encrypted_objects {
        status = "Enabled"
      }
    }
    destination {
      bucket        = aws_s3_bucket.audit_replica.arn
      storage_class = "STANDARD_IA"
      encryption_configuration {
        replica_kms_key_id = aws_kms_key.audit_replica.arn
      }
      metrics {
        status = "Enabled"
        event_threshold {
          minutes = 15
        }
      }
    }
  }

  resource "aws_s3_bucket_replication_configuration" "backups" {
    bucket = aws_s3_bucket.backups.id
    role   = aws_iam_role.s3_replication.arn
    rule {
      id     = "cross-region-backup-copy"
      status = "Enabled"
      filter {}
      delete_marker_replication {
        status = "Disabled"
      }
      source_selection_criteria {
        sse_kms_encrypted_objects {
          status = "Enabled"
        }
      }
      destination {
        bucket        = aws_s3_bucket.backups_replica.arn
        storage_class = "STANDARD_IA"
        encryption_configuration {
          replica_kms_key_id = aws_kms_key.audit_replica.arn
        }
        metrics {
          status = "Enabled"
          event_threshold {
            minutes = 15
          }
        }
      }
    }
    depends_on = [
      aws_iam_role_policy_attachment.s3_replication,
      aws_s3_bucket_versioning.backups,
      aws_s3_bucket_versioning.backups_replica,
    ]
  }

  depends_on = [
    aws_iam_role_policy_attachment.s3_replication,
    aws_s3_bucket_versioning.audit,
    aws_s3_bucket_versioning.audit_replica,
  ]
}

resource "aws_s3_bucket" "backups" {
  bucket        = "${var.name_prefix}-backups-${data.aws_caller_identity.current.account_id}-${var.aws_region}"
  force_destroy = false
  tags          = { Name = "${var.name_prefix}-backups" }
}

resource "aws_s3_bucket_public_access_block" "backups" {
  bucket                  = aws_s3_bucket.backups.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "backups" {
  bucket = aws_s3_bucket.backups.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.application.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id
  rule {
    id     = "expire-old-backup-objects"
    status = "Enabled"
    filter {}
    expiration {
      days = 365
    }
    noncurrent_version_expiration {
      noncurrent_days = 365
    }
  }
  depends_on = [aws_s3_bucket_versioning.backups]
}

resource "aws_backup_vault" "primary" {
  name        = "${var.name_prefix}-database"
  kms_key_arn = aws_kms_key.application.arn
  tags        = { Name = "${var.name_prefix}-database-backup" }
}

resource "aws_backup_vault" "replica" {
  provider    = aws.replica
  name        = "${var.name_prefix}-database-replica"
  kms_key_arn = aws_kms_key.audit_replica.arn
  tags        = { Name = "${var.name_prefix}-database-backup-replica" }
}

resource "aws_iam_role" "backup" {
  name               = "${var.name_prefix}-backup"
  assume_role_policy = data.aws_iam_policy_document.backup_assume_role.json
}

data "aws_iam_policy_document" "backup_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["backup.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy_attachment" "backup" {
  for_each = toset([
    "arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForBackup",
    "arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForRestores",
  ])
  role       = aws_iam_role.backup.name
  policy_arn = each.value
}

resource "aws_backup_plan" "database" {
  name = "${var.name_prefix}-database-pitr-copy"
  rule {
    rule_name         = "daily-cross-region-postgres"
    target_vault_name = aws_backup_vault.primary.name
    schedule          = "cron(0 5 ? * * *)"
    start_window      = 60
    completion_window = 360
    lifecycle {
      delete_after = 35
    }
    copy_action {
      destination_vault_arn = aws_backup_vault.replica.arn
      lifecycle {
        delete_after = 365
      }
    }
  }
  tags = { Name = "${var.name_prefix}-database-backups" }
}

resource "aws_backup_selection" "database" {
  name         = "${var.name_prefix}-database-resources"
  iam_role_arn = aws_iam_role.backup.arn
  plan_id      = aws_backup_plan.database.id
  resources = [
    aws_db_instance.primary.arn,
  ]
  depends_on = [aws_iam_role_policy_attachment.backup]
}
