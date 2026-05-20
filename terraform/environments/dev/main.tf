# Dev environment - standalone demo infrastructure

# VPC Module (dev creates its own isolated demo VPC)
module "vpc" {
  source = "../../modules/vpc"

  project_name       = var.project_name
  environment        = var.environment
  vpc_cidr           = var.vpc_cidr
  enable_nat_gateway = var.enable_nat_gateway
}

# Security Groups
module "security_groups" {
  source = "../../modules/security-groups"

  project_name = var.project_name
  environment  = var.environment
  vpc_id       = module.vpc.vpc_id
}

# Aurora Serverless v2 Database (dev has its own isolated database)
module "aurora" {
  source = "../../modules/aurora"

  project_name = var.project_name
  environment  = var.environment

  vpc_id            = module.vpc.vpc_id
  subnet_ids        = module.vpc.private_subnet_ids
  security_group_id = module.security_groups.aurora_security_group_id

  db_name      = var.db_name
  min_capacity = var.aurora_min_capacity
  max_capacity = var.aurora_max_capacity
}

# Elastic Beanstalk
module "elastic_beanstalk" {
  source = "../../modules/elastic-beanstalk"

  project_name = var.project_name
  environment  = var.environment
  aws_region   = var.aws_region

  vpc_id                        = module.vpc.vpc_id
  private_subnet_ids            = module.vpc.private_subnet_ids
  public_subnet_ids             = module.vpc.public_subnet_ids
  alb_security_group_id         = module.security_groups.alb_security_group_id
  eb_instance_security_group_id = module.security_groups.eb_instance_security_group_id
  instance_type                 = var.eb_instance_type
  seed_demo_data                = var.seed_demo_data
}

# CloudFront + S3 Frontend (dev has its own CDN + bucket)
module "cloudfront_s3" {
  source = "../../modules/cloudfront-s3"

  project_name         = var.project_name
  environment          = var.environment
  app_domain_name      = var.app_domain_name
  route53_zone_id      = var.route53_zone_id
  eb_environment_cname = module.elastic_beanstalk.environment_cname
  upload_cors_origins  = var.upload_cors_origins
}

# SSM Parameters (dev has environment-specific paths)
module "ssm" {
  source = "../../modules/ssm"

  project_name = var.project_name
  environment  = var.environment
  aws_region   = var.aws_region

  db_endpoint            = module.aurora.cluster_endpoint
  db_port                = 5432
  db_name                = var.db_name
  db_username            = module.aurora.master_username
  db_password            = module.aurora.master_password
  cloudfront_domain_name = module.cloudfront_s3.cloudfront_domain_name
  app_domain_name        = var.app_domain_name
  eb_instance_role_name  = module.elastic_beanstalk.instance_role_name
}
