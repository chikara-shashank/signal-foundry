# AWS / GCP deployment

The same Compose service runs on one persistent Linux VM. The templates create infrastructure only when you run Terraform. They do not deploy a paid resource or send an order during local setup. There is no autoscaling, public dashboard, or multi-region failover.

## Cost and capacity

Start with 2 vCPU / 8 GiB and 80 GiB persistent storage. The worker calculations are small; measure during market open before expanding the universe. The previous approximately $350 monthly allocation is a planning budget, not a cloud quote. VM, disk, public IPv4, snapshots, object storage, data egress, taxes, and model/data plans all count. Configure billing alerts at $300, $400, and $500; alerts do not impose a provider hard cap. AWS T3 uses standard CPU credits here to avoid unlimited-credit charges, which can mean throttling under sustained load. Resize only after measurement.

## AWS

Prerequisites: AWS CLI credentials for your account, Terraform >=1.6, an existing public subnet with Internet Gateway routing, its VPC ID, an existing EC2 SSH key, and your administrator IPv4 /32. No credentials go in Terraform variables.

```sh
cd deploy/aws
cp terraform.tfvars.example terraform.tfvars
# Fill the VPC, subnet, existing key name, and administrator IPv4.
terraform init
terraform fmt
terraform validate
terraform plan
terraform apply
```

This creates an Ubuntu 24.04 instance, encrypted root storage retained on termination, and SSH ingress from your /32 only. The application port has no inbound rule. `prevent_destroy` intentionally stops accidental deletion; decommissioning requires deliberate state/data review.

Package source on Windows from the project root:

```powershell
./scripts/package.ps1
scp -i YOUR_KEY.pem signal-foundry-source.zip ubuntu@VM_IP:/tmp/signal-foundry-source.zip
ssh -i YOUR_KEY.pem -L 8080:127.0.0.1:8080 ubuntu@VM_IP
```

## GCP

Prerequisites: a billed GCP project; Compute Engine and IAP APIs enabled; Terraform/ADC credentials; permissions to create compute/network resources; your login principal granted IAP tunnel access and OS Login admin access. No service-account key file is embedded. Review effective organization policies and quotas first.

```sh
gcloud auth application-default login
cd deploy/gcp
cp terraform.tfvars.example terraform.tfvars
# Set project_id, region, zone.
terraform init
terraform fmt
terraform validate
terraform plan
terraform apply
```

The template creates a dedicated network, persistent boot disk, shielded VM, and SSH ingress from IAP's forwarding range only. An external address supplies outbound connectivity; dashboard ingress is blocked. The disk and instance have deletion protections.

```sh
gcloud compute scp signal-foundry-source.zip signal-foundry:/tmp/signal-foundry-source.zip --project YOUR_PROJECT --zone us-east1-b --tunnel-through-iap
gcloud compute ssh signal-foundry --project YOUR_PROJECT --zone us-east1-b --tunnel-through-iap -- -L 8080:localhost:8080
```

## Install the source on either VM

Wait for the bootstrap to install Docker. AWS: `sudo cloud-init status --wait`. GCP: inspect `sudo journalctl -u google-startup-scripts.service` and confirm `sudo docker compose version` works. Then, in the SSH session:

```sh
sudo unzip -o /tmp/signal-foundry-source.zip -d /opt/signal-foundry
sudo chown -R "$(id -u):$(id -g)" /opt/signal-foundry
cd /opt/signal-foundry
sudo docker run --rm --user "$(id -u):$(id -g)" -v "$PWD:/app" -w /app node:24.13.0-bookworm-slim node scripts/setup.js
nano .env
chmod 600 .env
sudo docker compose build
sudo docker compose run --rm engine node scripts/doctor.js
sudo docker compose up -d --wait
sudo systemctl start signal-foundry
```

Enter paper keys first. Use the SSH tunnel's local `http://localhost:8080` dashboard and its token from the VM's `.env`. Close the tunnel without stopping the VM; execution continues. Keep the environment file off source control. For a managed secret store, retrieve the complete dotenv content into this root-protected host file using an appropriately scoped identity; do not put it in Terraform state or VM metadata.

Cloud deployment files are templates until `terraform validate` and a plan succeed against your installed provider versions/account. Read [verification](VERIFICATION.md) for what was actually validated in the build environment.

## Unattended-operation acceptance

Before leaving paper mode unattended, verify restart recovery, feed reconnection, volume retention after container replacement, backup export, external dead-man alert, disk usage, and cloud billing alerts. Kill a paper container and confirm the next one reconciles before trading. Review the broker's own position/order view, not only the dashboard. A VM or provider outage can interrupt crypto exits. A second VM must not trade concurrently against this account.
