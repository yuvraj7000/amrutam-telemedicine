terraform {
  required_version = ">= 1.6.0, < 2.0.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = "Amrutam"
      Environment = var.environment
      ManagedBy   = "Terraform"
    }
  }
}

provider "aws" {
  alias  = "replica"
  region = var.failover_region

  default_tags {
    tags = {
      Project     = "Amrutam"
      Environment = var.environment
      ManagedBy   = "Terraform"
    }
  }
}
