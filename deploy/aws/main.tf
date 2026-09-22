terraform {
  required_version = ">= 1.6, < 2.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.0" }
  }
}
provider "aws" { region = var.region }

variable "region" { default = "us-east-1" }
variable "vpc_id" { type = string }
variable "public_subnet_id" { type = string }
variable "ssh_key_name" { type = string }
variable "admin_ipv4_cidr" {
  type = string
  description = "Your current public IPv4 address with /32. Dashboard stays private."
  validation {
    condition = can(cidrnetmask(var.admin_ipv4_cidr)) && endswith(var.admin_ipv4_cidr, "/32")
    error_message = "Use one administrator IPv4 address with /32."
  }
}
variable "instance_type" { default = "t3.large" }

data "aws_ami" "ubuntu" {
  most_recent = true
  owners = ["099720109477"]
  filter {
    name = "name"
    values = ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*"]
  }
  filter {
    name = "virtualization-type"
    values = ["hvm"]
  }
}
resource "aws_security_group" "engine" {
  name_prefix = "signal-foundry-"
  description = "SSH from one administrator; no public application port"
  vpc_id = var.vpc_id
  ingress {
    from_port = 22
    to_port = 22
    protocol = "tcp"
    cidr_blocks = [var.admin_ipv4_cidr]
  }
  egress {
    from_port = 0
    to_port = 0
    protocol = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}
resource "aws_instance" "engine" {
  ami = data.aws_ami.ubuntu.id
  instance_type = var.instance_type
  subnet_id = var.public_subnet_id
  associate_public_ip_address = true
  key_name = var.ssh_key_name
  vpc_security_group_ids = [aws_security_group.engine.id]
  user_data = file("${path.module}/../bootstrap.sh")
  user_data_replace_on_change = false
  metadata_options {
    http_tokens = "required"
    http_put_response_hop_limit = 1
  }
  credit_specification { cpu_credits = "standard" }
  root_block_device {
    volume_size = 80
    volume_type = "gp3"
    encrypted = true
    delete_on_termination = false
  }
  lifecycle { prevent_destroy = true }
  tags = { Name = "signal-foundry", Purpose = "own-account-trading-research" }
}
output "public_ip" { value = aws_instance.engine.public_ip }
output "ssh_tunnel" { value = "ssh -i YOUR_KEY.pem -L 8080:127.0.0.1:8080 ubuntu@${aws_instance.engine.public_ip}" }
