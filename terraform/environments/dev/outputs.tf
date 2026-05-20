output "vpc_id" {
  description = "VPC ID"
  value       = module.vpc.vpc_id
}

output "private_subnet_ids" {
  description = "Private subnet IDs"
  value       = module.vpc.private_subnet_ids
}

output "public_subnet_ids" {
  description = "Public subnet IDs"
  value       = module.vpc.public_subnet_ids
}

output "aurora_cluster_endpoint" {
  description = "Aurora cluster endpoint"
  value       = module.aurora.cluster_endpoint
}

output "aurora_cluster_reader_endpoint" {
  description = "Aurora cluster reader endpoint"
  value       = module.aurora.cluster_reader_endpoint
}

output "database_name" {
  description = "Database name"
  value       = var.db_name
}

output "database_url_ssm_parameter" {
  description = "SSM parameter name for DATABASE_URL"
  value       = module.ssm.database_url_parameter_name
}

output "cors_origin_ssm_parameter" {
  description = "SSM parameter name for CORS_ORIGIN"
  value       = module.ssm.cors_origin_parameter_name
}

output "s3_bucket_name" {
  description = "S3 bucket for frontend"
  value       = module.cloudfront_s3.s3_bucket_name
}

output "cloudfront_distribution_id" {
  description = "CloudFront distribution ID"
  value       = module.cloudfront_s3.cloudfront_distribution_id
}

output "cloudfront_domain_name" {
  description = "CloudFront domain name"
  value       = module.cloudfront_s3.cloudfront_domain_name
}

output "frontend_url" {
  description = "Frontend URL (use this to access the application)"
  value       = module.cloudfront_s3.frontend_url
}

output "api_url" {
  description = "API URL (use this after EB deployment)"
  value       = var.api_domain_name != "" ? "https://${var.api_domain_name}" : "Set after EB environment creation"
}

output "eb_application_name" {
  description = "Elastic Beanstalk application name"
  value       = module.elastic_beanstalk.application_name
}

output "eb_instance_profile" {
  description = "Elastic Beanstalk instance profile name"
  value       = module.elastic_beanstalk.instance_profile_name
}

output "eb_service_role_arn" {
  description = "Elastic Beanstalk service role ARN"
  value       = module.elastic_beanstalk.service_role_arn
}

# Output for EB CLI configuration
output "eb_config_summary" {
  description = "Configuration values for EB CLI setup"
  value = {
    application_name        = module.elastic_beanstalk.application_name
    instance_profile        = module.elastic_beanstalk.instance_profile_name
    service_role_arn        = module.elastic_beanstalk.service_role_arn
    vpc_id                  = module.vpc.vpc_id
    private_subnets         = join(",", module.vpc.private_subnet_ids)
    public_subnets          = join(",", module.vpc.public_subnet_ids)
    instance_security_group = module.security_groups.eb_instance_security_group_id
    alb_security_group      = module.security_groups.alb_security_group_id
  }
}
