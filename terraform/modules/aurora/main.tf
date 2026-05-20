resource "random_password" "db_password" {
  length  = 32
  special = false # Avoid special chars that might cause issues
}

resource "aws_db_subnet_group" "aurora" {
  name       = "${var.project_name}-${var.environment}-aurora"
  subnet_ids = var.subnet_ids

  tags = {
    Name = "${var.project_name}-${var.environment}-aurora-subnet-group"
  }
}

resource "aws_rds_cluster_parameter_group" "aurora" {
  name   = "${var.project_name}-${var.environment}-aurora-pg16"
  family = "aurora-postgresql16"

  parameter {
    name  = "log_statement"
    value = "ddl"
  }

  parameter {
    name  = "log_min_duration_statement"
    value = "1000" # Log queries taking > 1s
  }

  # DDoS protection: Connection and query limits
  parameter {
    name         = "max_connections"
    value        = "200"
    apply_method = "pending-reboot"
  }

  parameter {
    name  = "idle_in_transaction_session_timeout"
    value = "30000" # 30 seconds - terminate idle transactions
  }

  parameter {
    name  = "statement_timeout"
    value = "30000" # 30 seconds - terminate long-running queries
  }

  # DDoS forensics: Log connection events for attack analysis
  parameter {
    name  = "log_connections"
    value = "1"
  }

  parameter {
    name  = "log_disconnections"
    value = "1"
  }

  tags = {
    Name = "${var.project_name}-${var.environment}-aurora-pg16"
  }
}

resource "aws_rds_cluster" "aurora" {
  cluster_identifier              = "${var.project_name}-${var.environment}-aurora"
  engine                          = "aurora-postgresql"
  engine_mode                     = "provisioned"
  engine_version                  = "16.4"
  database_name                   = var.db_name
  master_username                 = "postgres"
  master_password                 = random_password.db_password.result
  storage_encrypted               = true
  skip_final_snapshot             = var.environment != "prod"
  final_snapshot_identifier       = var.environment == "prod" ? "${var.project_name}-final-snapshot-${formatdate("YYYY-MM-DD-hhmm", timestamp())}" : null
  backup_retention_period         = var.environment == "prod" ? 7 : 1
  preferred_backup_window         = "03:00-04:00"
  preferred_maintenance_window    = "sun:04:00-sun:05:00"
  enabled_cloudwatch_logs_exports = ["postgresql"]

  db_cluster_parameter_group_name = aws_rds_cluster_parameter_group.aurora.name
  vpc_security_group_ids          = [var.security_group_id]
  db_subnet_group_name            = aws_db_subnet_group.aurora.name

  serverlessv2_scaling_configuration {
    min_capacity = var.min_capacity
    max_capacity = var.max_capacity
  }

  tags = {
    Name = "${var.project_name}-${var.environment}-aurora-cluster"
  }

  lifecycle {
    ignore_changes = [final_snapshot_identifier]
  }
}

resource "aws_rds_cluster_instance" "aurora" {
  cluster_identifier   = aws_rds_cluster.aurora.id
  identifier           = "${var.project_name}-${var.environment}-aurora-instance-1"
  instance_class       = "db.serverless"
  engine               = aws_rds_cluster.aurora.engine
  engine_version       = aws_rds_cluster.aurora.engine_version
  publicly_accessible  = false
  db_subnet_group_name = aws_db_subnet_group.aurora.name

  tags = {
    Name = "${var.project_name}-${var.environment}-aurora-instance-1"
  }
}

# CloudWatch Log Group for Aurora logs
resource "aws_cloudwatch_log_group" "aurora" {
  name              = "/aws/rds/cluster/${aws_rds_cluster.aurora.cluster_identifier}/postgresql"
  retention_in_days = 30

  tags = {
    Name = "${var.project_name}-${var.environment}-aurora-logs"
  }
}
