const express = require('express');
const {
  createSellerApplication,
  getSellerApplications,
  getSellerApplication,
  updateSellerApplication,
  deleteSellerApplication,
  getAvailableApplications,
} = require('../controllers/sellerApplicationController');

const { protect, authorize } = require('../middleware/auth');

const router = express.Router();

// All routes require authentication + admin role
router.use(protect);
router.use(authorize('admin'));

// Create new seller application
router.post('/', createSellerApplication);

// Get all seller applications
router.get('/', getSellerApplications);

// Get available applications (for assignment)
router.get('/available', getAvailableApplications);

// Get single seller application
router.get('/:id', getSellerApplication);

// Update seller application
router.put('/:id', updateSellerApplication);

// Delete (deactivate) seller application
router.delete('/:id', deleteSellerApplication);

module.exports = router;
