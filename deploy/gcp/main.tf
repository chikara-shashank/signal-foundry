terraform {
  required_version = ">= 1.6, < 2.0"
  required_providers {
    google = { source = "hashicorp/google", version = "~> 7.0" }
  }
}
variable "project_id" { type = string }
variable "region" { default = "us-east1" }
variable "zone" { default = "us-east1-b" }
variable "machine_type" { default = "e2-standard-2" }
provider "google" { project = var.project_id }

resource "google_compute_network" "engine" {
  name = "signal-foundry"
  auto_create_subnetworks = false
}
resource "google_compute_subnetwork" "engine" {
  name = "signal-foundry"
  region = var.region
  network = google_compute_network.engine.id
  ip_cidr_range = "10.44.0.0/24"
}
resource "google_compute_firewall" "iap_ssh" {
  name = "signal-foundry-iap-ssh"
  network = google_compute_network.engine.name
  source_ranges = ["35.235.240.0/20"]
  target_tags = ["signal-foundry"]
  allow {
    protocol = "tcp"
    ports = ["22"]
  }
}
resource "google_compute_disk" "engine" {
  name = "signal-foundry-data-and-os"
  zone = var.zone
  type = "pd-balanced"
  size = 80
  image = "ubuntu-os-cloud/ubuntu-2404-lts-amd64"
  lifecycle { prevent_destroy = true }
}
resource "google_compute_instance" "engine" {
  name = "signal-foundry"
  zone = var.zone
  machine_type = var.machine_type
  tags = ["signal-foundry"]
  deletion_protection = true
  boot_disk {
    source = google_compute_disk.engine.id
    auto_delete = false
  }
  network_interface {
    subnetwork = google_compute_subnetwork.engine.id
    access_config {}
  }
  metadata = {
    enable-oslogin = "TRUE"
    block-project-ssh-keys = "TRUE"
  }
  metadata_startup_script = file("${path.module}/../bootstrap.sh")
  shielded_instance_config {
    enable_secure_boot = true
    enable_vtpm = true
    enable_integrity_monitoring = true
  }
  scheduling { automatic_restart = true }
  lifecycle { prevent_destroy = true }
}
output "tunnel_command" { value = "gcloud compute ssh signal-foundry --project ${var.project_id} --zone ${var.zone} --tunnel-through-iap -- -L 8080:localhost:8080" }
