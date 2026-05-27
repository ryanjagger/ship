# Origin Request Policy for API - forwards all headers, cookies, and query strings
# Using AllViewerAndWhitelistCloudFront to avoid body size limits
# that occur with legacy forwarded_values headers=["*"]
resource "aws_cloudfront_origin_request_policy" "api" {
  name    = "${var.project_name}-api-origin-request"
  comment = "Forward all viewer data to API origin"

  cookies_config {
    cookie_behavior = "all"
  }

  headers_config {
    header_behavior = "allViewerAndWhitelistCloudFront"
    headers {
      items = ["CloudFront-Forwarded-Proto"]
    }
  }

  query_strings_config {
    query_string_behavior = "all"
  }
}

# Cache Policy for API - disable caching
resource "aws_cloudfront_cache_policy" "api_no_cache" {
  name        = "${var.project_name}-api-no-cache"
  comment     = "Disable caching for API routes"
  default_ttl = 0
  max_ttl     = 0
  min_ttl     = 0

  parameters_in_cache_key_and_forwarded_to_origin {
    cookies_config {
      cookie_behavior = "none"
    }
    headers_config {
      header_behavior = "none"
    }
    query_strings_config {
      query_string_behavior = "none"
    }
  }
}

# S3 Bucket for React Frontend (includes account ID for global uniqueness)
resource "aws_s3_bucket" "frontend" {
  bucket = "${var.project_name}-frontend-${var.environment}-${data.aws_caller_identity.current.account_id}"

  tags = {
    Name = "${var.project_name}-frontend"
  }
}

# Block all public access (CloudFront will use OAC)
resource "aws_s3_bucket_public_access_block" "frontend" {
  bucket = aws_s3_bucket.frontend.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Enable versioning for compliance
resource "aws_s3_bucket_versioning" "frontend" {
  bucket = aws_s3_bucket.frontend.id

  versioning_configuration {
    status = "Enabled"
  }
}

# Server-side encryption
resource "aws_s3_bucket_server_side_encryption_configuration" "frontend" {
  bucket = aws_s3_bucket.frontend.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# CloudFront Origin Access Control
resource "aws_cloudfront_origin_access_control" "frontend" {
  name                              = "${var.project_name}-frontend-oac"
  description                       = "OAC for Ship frontend S3 bucket"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# CloudFront Function for SPA routing
# This function runs on viewer-request for the S3 origin (default cache behavior).
# It rewrites requests for SPA routes to /index.html while passing through static assets.
# We use a function instead of custom_error_response because custom_error_response
# applies to ALL origins including API, which would break API 404 responses.
resource "aws_cloudfront_function" "spa_routing" {
  name    = "${var.project_name}-spa-routing"
  runtime = "cloudfront-js-2.0"
  comment = "SPA routing - rewrites non-file requests to /index.html"
  publish = true

  code = file("${path.module}/cloudfront-functions/spa-routing.js")
}

# CloudFront Distribution
resource "aws_cloudfront_distribution" "frontend" {
  enabled             = true
  is_ipv6_enabled     = true
  comment             = "Ship Frontend - React static site with API routing"
  default_root_object = "index.html"
  price_class         = "PriceClass_100" # US, Canada, Europe only

  # WAF WebACL for CloudFront protection
  # Uses provided ARN if set, otherwise creates managed WAF (see waf.tf)
  web_acl_id = var.cloudfront_waf_web_acl_id != "" ? var.cloudfront_waf_web_acl_id : aws_wafv2_web_acl.cloudfront[0].arn

  aliases = var.app_domain_name != "" ? [var.app_domain_name] : []

  # Origin 1: S3 for static assets
  origin {
    domain_name              = aws_s3_bucket.frontend.bucket_regional_domain_name
    origin_id                = "S3-${aws_s3_bucket.frontend.id}"
    origin_access_control_id = aws_cloudfront_origin_access_control.frontend.id
  }

  # Origin 2: Elastic Beanstalk API (conditional - only when CNAME is provided)
  dynamic "origin" {
    for_each = var.eb_environment_cname != "" ? [1] : []
    content {
      domain_name = var.eb_environment_cname
      origin_id   = "EB-API"

      custom_origin_config {
        http_port              = 80
        https_port             = 443
        origin_protocol_policy = "http-only"
        origin_ssl_protocols   = ["TLSv1.2"]
      }
    }
  }

  # FleetGraph chat SSE stream (U9) - MUST precede the broader "/api/*" behavior
  # so this more-specific path wins. SSE requires compression OFF (CloudFront must
  # not buffer/transform the event-stream) and no caching. Mirrors the
  # /collaboration/* and /events streaming behaviors (compress=false, ttl=0,
  # all-viewer headers via the api origin-request policy). See
  # docs/solutions/websocket-cloudfront-configuration.md.
  dynamic "ordered_cache_behavior" {
    for_each = var.eb_environment_cname != "" ? [1] : []
    content {
      path_pattern           = "/api/fleetgraph/chat"
      target_origin_id       = "EB-API"
      viewer_protocol_policy = "redirect-to-https"
      allowed_methods        = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
      cached_methods         = ["GET", "HEAD"]
      compress               = false

      # Use policies instead of forwarded_values; api_no_cache enforces ttl=0 and
      # the api origin-request policy forwards all viewer headers/cookies/query.
      cache_policy_id          = aws_cloudfront_cache_policy.api_no_cache.id
      origin_request_policy_id = aws_cloudfront_origin_request_policy.api.id
    }
  }

  # API routes - forward to EB (only when EB is configured)
  # Uses origin request policy instead of legacy forwarded_values to avoid body size limits
  dynamic "ordered_cache_behavior" {
    for_each = var.eb_environment_cname != "" ? [1] : []
    content {
      path_pattern           = "/api/*"
      target_origin_id       = "EB-API"
      viewer_protocol_policy = "redirect-to-https"
      allowed_methods        = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
      cached_methods         = ["GET", "HEAD"]
      compress               = true

      # Use policies instead of forwarded_values for larger request body support
      cache_policy_id          = aws_cloudfront_cache_policy.api_no_cache.id
      origin_request_policy_id = aws_cloudfront_origin_request_policy.api.id
    }
  }

  # Health check endpoint (only when EB is configured)
  dynamic "ordered_cache_behavior" {
    for_each = var.eb_environment_cname != "" ? [1] : []
    content {
      path_pattern           = "/health"
      target_origin_id       = "EB-API"
      viewer_protocol_policy = "redirect-to-https"
      allowed_methods        = ["GET", "HEAD"]
      cached_methods         = ["GET", "HEAD"]
      compress               = true
      min_ttl                = 0
      default_ttl            = 0
      max_ttl                = 0

      forwarded_values {
        query_string = false
        cookies {
          forward = "none"
        }
      }
    }
  }

  # WebSocket collaboration endpoint (only when EB is configured)
  # Uses origin request policy for WebSocket compatibility
  dynamic "ordered_cache_behavior" {
    for_each = var.eb_environment_cname != "" ? [1] : []
    content {
      path_pattern           = "/collaboration/*"
      target_origin_id       = "EB-API"
      viewer_protocol_policy = "redirect-to-https"
      allowed_methods        = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
      cached_methods         = ["GET", "HEAD"]
      compress               = false

      # Use policies instead of forwarded_values
      cache_policy_id          = aws_cloudfront_cache_policy.api_no_cache.id
      origin_request_policy_id = aws_cloudfront_origin_request_policy.api.id
    }
  }

  # WebSocket events endpoint for real-time updates (only when EB is configured)
  # Uses origin request policy for WebSocket compatibility
  dynamic "ordered_cache_behavior" {
    for_each = var.eb_environment_cname != "" ? [1] : []
    content {
      path_pattern           = "/events"
      target_origin_id       = "EB-API"
      viewer_protocol_policy = "redirect-to-https"
      allowed_methods        = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
      cached_methods         = ["GET", "HEAD"]
      compress               = false

      # Use policies instead of forwarded_values
      cache_policy_id          = aws_cloudfront_cache_policy.api_no_cache.id
      origin_request_policy_id = aws_cloudfront_origin_request_policy.api.id
    }
  }

  # Well-known endpoints for OAuth/OIDC (JWKS, etc.) - only when EB is configured
  dynamic "ordered_cache_behavior" {
    for_each = var.eb_environment_cname != "" ? [1] : []
    content {
      path_pattern           = "/.well-known/*"
      target_origin_id       = "EB-API"
      viewer_protocol_policy = "redirect-to-https"
      allowed_methods        = ["GET", "HEAD"]
      cached_methods         = ["GET", "HEAD"]
      compress               = true
      min_ttl                = 0
      default_ttl            = 3600 # Cache JWKS for 1 hour
      max_ttl                = 86400

      forwarded_values {
        query_string = false
        cookies {
          forward = "none"
        }
      }
    }
  }

  default_cache_behavior {
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    target_origin_id       = "S3-${aws_s3_bucket.frontend.id}"
    viewer_protocol_policy = "redirect-to-https"
    compress               = true
    min_ttl                = 0
    default_ttl            = 3600
    max_ttl                = 86400

    # Real-time logging for security monitoring
    realtime_log_config_arn = aws_cloudfront_realtime_log_config.main.arn

    forwarded_values {
      query_string = false
      cookies {
        forward = "none"
      }
    }

    # SPA routing via CloudFront function (not custom_error_response)
    # This ensures only S3 origin requests are rewritten, not API error responses
    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.spa_routing.arn
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = var.app_domain_name == ""
    acm_certificate_arn            = var.app_domain_name != "" ? aws_acm_certificate.app[0].arn : null
    ssl_support_method             = var.app_domain_name != "" ? "sni-only" : null
    minimum_protocol_version       = "TLSv1.2_2021"
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  tags = {
    Name = "${var.project_name}-frontend-cdn"
  }
}

# S3 bucket policy for CloudFront OAC
resource "aws_s3_bucket_policy" "frontend" {
  bucket = aws_s3_bucket.frontend.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AllowCloudFrontServicePrincipal"
        Effect = "Allow"
        Principal = {
          Service = "cloudfront.amazonaws.com"
        }
        Action   = "s3:GetObject"
        Resource = "${aws_s3_bucket.frontend.arn}/*"
        Condition = {
          StringEquals = {
            "AWS:SourceArn" = aws_cloudfront_distribution.frontend.arn
          }
        }
      }
    ]
  })
}

# ACM Certificate for custom domain (must be in us-east-1 for CloudFront)
resource "aws_acm_certificate" "app" {
  count             = var.app_domain_name != "" ? 1 : 0
  provider          = aws
  domain_name       = var.app_domain_name
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }

  tags = {
    Name = "${var.project_name}-app-cert"
  }
}

# Route53 record for ACM validation
resource "aws_route53_record" "app_cert_validation" {
  for_each = var.app_domain_name != "" && var.route53_zone_id != "" ? {
    for dvo in aws_acm_certificate.app[0].domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      type   = dvo.resource_record_type
      record = dvo.resource_record_value
    }
  } : {}

  zone_id = var.route53_zone_id
  name    = each.value.name
  type    = each.value.type
  records = [each.value.record]
  ttl     = 60
}

# Certificate validation
resource "aws_acm_certificate_validation" "app" {
  count                   = var.app_domain_name != "" && var.route53_zone_id != "" ? 1 : 0
  certificate_arn         = aws_acm_certificate.app[0].arn
  validation_record_fqdns = [for record in aws_route53_record.app_cert_validation : record.fqdn]
}

# Route53 record for CloudFront distribution
resource "aws_route53_record" "app" {
  count   = var.app_domain_name != "" && var.route53_zone_id != "" ? 1 : 0
  zone_id = var.route53_zone_id
  name    = var.app_domain_name
  type    = "A"

  alias {
    name                   = aws_cloudfront_distribution.frontend.domain_name
    zone_id                = aws_cloudfront_distribution.frontend.hosted_zone_id
    evaluate_target_health = false
  }
}

# =============================================================================
# S3 Bucket for File Uploads
# =============================================================================

# S3 Bucket for user file uploads (documents, videos, etc.)
resource "aws_s3_bucket" "uploads" {
  bucket = "${var.project_name}-uploads-${var.environment}-${data.aws_caller_identity.current.account_id}"

  tags = {
    Name = "${var.project_name}-uploads"
  }
}

# Block all public access (files served via presigned URLs)
resource "aws_s3_bucket_public_access_block" "uploads" {
  bucket = aws_s3_bucket.uploads.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Enable versioning for compliance and recovery
resource "aws_s3_bucket_versioning" "uploads" {
  bucket = aws_s3_bucket.uploads.id

  versioning_configuration {
    status = "Enabled"
  }
}

# Server-side encryption (AES256)
resource "aws_s3_bucket_server_side_encryption_configuration" "uploads" {
  bucket = aws_s3_bucket.uploads.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# CORS configuration for browser uploads
resource "aws_s3_bucket_cors_configuration" "uploads" {
  bucket = aws_s3_bucket.uploads.id

  cors_rule {
    allowed_headers = ["*"]
    allowed_methods = ["PUT", "POST"]
    allowed_origins = var.upload_cors_origins
    expose_headers  = ["ETag"]
    max_age_seconds = 3600
  }
}

# Lifecycle rule to clean up incomplete multipart uploads
resource "aws_s3_bucket_lifecycle_configuration" "uploads" {
  bucket = aws_s3_bucket.uploads.id

  rule {
    id     = "abort-incomplete-multipart"
    status = "Enabled"

    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}
